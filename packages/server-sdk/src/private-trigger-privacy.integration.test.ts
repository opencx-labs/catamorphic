import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AccessDeniedError,
  CatamorphicCore,
  type Identity,
} from "@catamorphic/core";
import { type DB, migrateToLatest } from "@catamorphic/db";
import { createApp } from "@catamorphic/fastify-plugin";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { TestSandboxes } from "@catamorphic/sandbox/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScopedClient } from "./scoped-client.js";
import { defineStaticEnvironments } from "./static-environments.js";

const schema = "private_trigger_http";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(schema)],
});
const owner: Identity = { tenantId: randomUUID(), externalUserId: "owner" };
const projectId = randomUUID();
const name = "privateSync";
const foreignCallers: Identity[] = [
  { ...owner, externalUserId: "foreign-root" },
  {
    ...owner,
    externalUserId: "foreign-member",
    scope: [{ kind: "workflow", projectId, name }],
    projectPermissions: [
      { projectId, permission: "automations:read" },
      { projectId, permission: "automations:write" },
    ],
  },
];
const sandboxes = new TestSandboxes();
let directory: string;
let core: CatamorphicCore;
let app: ReturnType<typeof createApp>;
let enablementId: string;
let consentDigest: string;

describe("private trigger HTTP and SDK isolation", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: owner.tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: owner.tenantId, name: "P" })
      .execute();
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "private-trigger-http-"),
    );
    const folder = path.join(directory, "project");
    await fs.mkdir(folder);
    const roots = async () => folder;
    const provider = sandboxes.track(
      new LocalProcessSandboxProvider({
        root: path.join(directory, "sandboxes"),
      }),
    );
    core = new CatamorphicCore({
      db,
      projectManager: new ProjectManager(
        new FsBackend(path.join(directory, "copies"), roots),
        new FsRemoteBackend(path.join(directory, "origins")),
        roots,
      ),
      sandboxProvider: provider,
      environmentProvider: defineStaticEnvironments([
        {
          descriptor: {
            id: "local",
            label: "Local",
            trust: "local",
            isolation: "process",
            workloads: ["workflow"],
            agentTopologies: [],
            capabilities: [],
            resources: {},
          },
          sandboxProvider: provider,
        },
      ]),
      triggerKinds: [
        {
          name: "private.sync",
          configJsonSchema: { type: "object" },
          payloadJsonSchema: { type: "object" },
          validateConfig: () => ({ ok: true }),
          validatePayload: () => ({ ok: true }),
        },
      ],
    });
    const client = new ScopedClient(core, owner);
    const { artifact } = await client.sessionArtifacts.create({
      projectId,
      name,
      lifetime: "member",
      kind: "workflow",
      source: `import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
export const privateSync = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("private.sync", { title: "Private reminder title" })],
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{}>) => ({ secret: "owner-only" }) })]
}));`,
    });
    const address = {
      projectId,
      artifactId: artifact.id,
      revision: artifact.revision,
    };
    const preview = await client.privateWorkflows.preview(address);
    const enabled = await client.privateWorkflows.activate({
      ...address,
      consentDigest: preview.consentDigest,
    });
    enablementId = enabled.id;
    consentDigest = enabled.consentDigest;
    await client.sessionArtifacts.update({
      ...address,
      files: {
        [artifact.sourcePath]: `${(await client.sessionArtifacts.files({ projectId, artifactId: artifact.id }))[artifact.sourcePath]}\n// Next private revision\n`,
      },
    });
    app = createApp({
      core,
      identity: (request) =>
        foreignCallers.find(
          (caller) => caller.externalUserId === request.headers["x-test-user"],
        ) ?? owner,
    });
  });

  afterAll(async () => {
    await app?.close();
    await core?.runs.stopWorkers();
    await sandboxes.cleanup();
    await db.destroy();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("denies foreign scoped and root callers before HTTP or SDK enrollment", async () => {
    for (const caller of foreignCallers) {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/triggers/private.sync/fire`,
        headers: { "x-test-user": caller.externalUserId },
        payload: { payload: {}, mode: "sync", workflows: [name] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("owner-only");
      await expect(
        new ScopedClient(core, caller).triggers.fire({
          projectId,
          kind: "private.sync",
          payload: {},
          mode: "sync",
          workflows: [name],
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    const runs = await db.selectFrom("workflow_runs").select("id").execute();
    expect(runs).toEqual([]);
  });

  it("returns the owner's private sync result through the same HTTP and SDK entry points", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/triggers/private.sync/fire`,
      payload: { payload: {}, mode: "sync", workflows: [name] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runs: [{ status: "completed", output: { secret: "owner-only" } }],
    });
    const result = await new ScopedClient(core, owner).triggers.fire({
      projectId,
      kind: "private.sync",
      payload: {},
      mode: "sync",
      workflows: [name],
    });
    expect(result.runs).toEqual([
      expect.objectContaining({
        status: "completed",
        output: { secret: "owner-only" },
      }),
    ]);
  });

  it("excludes private enablement metadata and rejects foreign administration over HTTP and SDK", async () => {
    const url = `/api/projects/${projectId}/workflow-enablements/${enablementId}`;
    for (const caller of foreignCallers) {
      const headers = { "x-test-user": caller.externalUserId };
      const client = new ScopedClient(core, caller);
      const denied = await app.inject({ method: "GET", url, headers });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain("Private reminder title");
      const listing = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/workflow-enablements`,
        headers,
      });
      expect(listing.statusCode).toBe(200);
      expect(listing.json().items).toEqual([]);
      await expect(
        client.workflowEnablements.get({ enablementId }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(
        await client.workflowEnablements.list({ projectId, includeAll: true }),
      ).toEqual([]);
      for (const action of ["disable", "reenable"] as const) {
        const response = await app.inject({
          method: "POST",
          url: `${url}/${action}`,
          headers,
        });
        expect(response.statusCode).toBe(403);
        await expect(
          client.workflowEnablements[action]({ enablementId }),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
      await expect(
        client.workflowEnablements.updateDeployment({
          enablementId,
          consentDigest,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      const update = await app.inject({
        method: "POST",
        url: `${url}/update-deployment`,
        headers,
        payload: { consentDigest },
      });
      expect(update.statusCode).toBe(403);
    }
    const result = await app.inject({ method: "GET", url });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      status: "active",
      revision: 1,
      triggers: [{ config: { title: "Private reminder title" } }],
    });
  });
});
