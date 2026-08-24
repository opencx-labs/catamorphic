import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import {
  FsBackend,
  FsRemoteBackend,
  ProjectManager,
  push,
} from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { resolveRoles } from "../services/roles-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0055: roles are committed files read from the shared origin; the
 * stock memberships table turns `user → roles + grants` into an identity
 * through them. Together they are the whole body of a host's resolver.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_roles_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

describeIf("RolesService + MembershipsService (ADR 0055)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectManager: ProjectManager;
  let projectId: string;
  let admin: Identity;

  async function commitRoles(files: Record<string, string>) {
    const repo = await projectManager.openDev(
      root.tenantId,
      projectId,
      root.externalUserId,
    );
    try {
      for (const [file, content] of Object.entries(files)) {
        await repo.writeFile(file, content);
      }
      await repo.commit("roles", { name: "root", email: "root@example.com" });
      const remote = projectManager.remoteBackend;
      if (!remote) throw new Error("expected a remote backend");
      await push({ dev: repo, remote, tenantId: root.tenantId, projectId });
    } finally {
      await repo.dispose();
    }
    core.roles.invalidate(projectId);
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-roles-"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 4 });
    await migrateToLatest({ db, schema });
    core = new CatamorphicCore({
      db,
      projectManager,
      environmentProvider: testEnvironmentProvider(),
      rolesCacheTtlMs: 0,
    });
    const project = await core.projects.create(root, { name: "brain" });
    projectId = project.id;
    admin = {
      ...root,
      externalUserId: "admin",
      scope: [{ kind: "project", projectId }],
    };

    await commitRoles({
      "roles/csm.json": JSON.stringify({
        version: 1,
        name: "CSM",
        agents: ["csm-assistant"],
        workflows: ["crm.lookup"],
        documents: [
          "docs/**",
          { path: "store/customers/{customer}/**", access: "write" },
        ],
      }),
      "roles/admin.json": JSON.stringify({
        version: 1,
        name: "Admin",
        builder: true,
        documents: ["store/**"],
      }),
      "roles/broken.json": "{ nope",
    });
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists the project's roles for builders, reporting broken files", async () => {
    const roles = await core.roles.list(admin, projectId);
    expect(roles.map((r) => r.slug)).toEqual(["admin", "broken", "csm"]);
    expect(roles.find((r) => r.slug === "csm")?.definition?.name).toBe("CSM");
    expect(roles.find((r) => r.slug === "broken")?.invalid?.error).toMatch(
      /JSON/,
    );
    const viewer: Identity = {
      ...root,
      externalUserId: "v",
      scope: [{ kind: "agent", projectId, name: "csm-assistant" }],
    };
    await expect(core.roles.list(viewer, projectId)).rejects.toThrow(
      AccessDeniedError,
    );
  });

  it("resolveRoles expands roles + grants into an identity; unknown roles grant nothing", async () => {
    const alice = await resolveRoles(core, {
      tenantId: root.tenantId,
      projectId,
      externalUserId: "alice",
      roles: ["csm", "does-not-exist", "broken"],
      grants: { customer: ["acme"] },
    });
    expect(alice.scope).toEqual([
      { kind: "agent", projectId, name: "csm-assistant" },
      { kind: "workflow", projectId, name: "crm.lookup" },
      { kind: "document", projectId, path: "docs/**" },
      {
        kind: "document",
        projectId,
        path: "store/customers/acme/**",
        access: "write",
      },
    ]);
    // No roles: a valid identity of nothing, not null.
    const nobody = await resolveRoles(core, {
      tenantId: root.tenantId,
      projectId,
      externalUserId: "nobody",
      roles: [],
    });
    expect(nobody.scope).toEqual([]);
  });

  it("memberships: grant → identityFor → revoke, builders only", async () => {
    const viewer: Identity = {
      ...root,
      externalUserId: "v",
      scope: [{ kind: "agent", projectId, name: "csm-assistant" }],
    };
    await expect(
      core.memberships.grant({
        identity: viewer,
        projectId,
        externalUserId: "mallory",
        roles: ["admin"],
      }),
    ).rejects.toThrow(AccessDeniedError);

    const bob = await core.memberships.grant({
      identity: admin,
      projectId,
      externalUserId: "bob",
      roles: ["csm", "csm"],
      grants: { customer: ["globex", "globex", ""] },
    });
    expect(bob.roles).toEqual(["csm"]);
    expect(bob.grants).toEqual({ customer: ["globex"] });

    const identity = await core.memberships.identityFor({
      projectId,
      tenantId: root.tenantId,
      externalUserId: "bob",
    });
    expect(identity?.scope).toContainEqual({
      kind: "document",
      projectId,
      path: "store/customers/globex/**",
      access: "write",
    });
    // Not a member → null (the host decides 401/403).
    expect(
      await core.memberships.identityFor({
        projectId,
        tenantId: root.tenantId,
        externalUserId: "stranger",
      }),
    ).toBeNull();
    // Another tenant's project id yields nothing, even with a row.
    expect(
      await core.memberships.identityFor({
        projectId,
        tenantId: crypto.randomUUID(),
        externalUserId: "bob",
      }),
    ).toBeNull();

    // Members read their own row; only builders read others'.
    const bobSelf: Identity = { ...root, externalUserId: "bob", scope: [] };
    expect(
      (
        await core.memberships.get({
          identity: bobSelf,
          projectId,
          externalUserId: "bob",
        })
      )?.roles,
    ).toEqual(["csm"]);
    await expect(
      core.memberships.get({
        identity: bobSelf,
        projectId,
        externalUserId: "alice",
      }),
    ).rejects.toThrow(AccessDeniedError);

    expect(
      (await core.memberships.list({ identity: admin, projectId })).map(
        (m) => m.externalUserId,
      ),
    ).toEqual(["bob"]);
    expect(
      await core.memberships.revoke({
        identity: admin,
        projectId,
        externalUserId: "bob",
      }),
    ).toBe(true);
    expect(
      await core.memberships.identityFor({
        projectId,
        tenantId: root.tenantId,
        externalUserId: "bob",
      }),
    ).toBeNull();
  });

  it("role edits reach members after the cache turns over", async () => {
    await core.memberships.grant({
      identity: admin,
      projectId,
      externalUserId: "carol",
      roles: ["csm"],
    });
    await commitRoles({
      "roles/csm.json": JSON.stringify({
        version: 1,
        name: "CSM",
        agents: ["csm-assistant"],
        workflows: ["crm.lookup", "docs.search"],
      }),
    });
    const carol = await core.memberships.identityFor({
      projectId,
      tenantId: root.tenantId,
      externalUserId: "carol",
    });
    expect(carol?.scope).toContainEqual({
      kind: "workflow",
      projectId,
      name: "docs.search",
    });
    expect(carol?.scope?.some((r) => r.kind === "document")).toBe(false);
  });
});
