import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { TestSandboxes } from "@catamorphic/sandbox/testing";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { DocumentConflictError } from "../services/documents-service.js";
import { UserNotificationsService } from "../services/user-notifications-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin("private_customizations")],
});
const identity: Identity = { tenantId: randomUUID(), externalUserId: "owner" };
const projectId = randomUUID();
let directory: string;
let folder: string;
let core: CatamorphicCore;
const alerts: string[] = [];
const notificationKinds: string[] = [];
let liveMember: Identity | null = {
  ...identity,
  externalUserId: "member-owner",
  scope: [{ kind: "workflow", projectId, name: "revoked" }],
  executionScope: [{ projectId, name: "default" }],
  projectPermissions: [{ projectId, permission: "notifications:write" }],
};
const sandboxes = new TestSandboxes();
const workflow = `import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
export const reminders = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["notifications:write"],
  triggers: [trigger("schedule", { at: "2020-01-01T00:00:00Z" })],
  steps: [defineBoundary({ run: ({ host }: BoundaryContext<{ activationId: string; scheduledFor: string; firedAt: string }>) => host["catamorphic.notifications"].publish({ title: "Review today", idempotencyKey: "reminder:1" }) })]
}));`;

describe("private customizations use ordinary durable services", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema: "private_customizations" });
    await db
      .insertInto("tenants")
      .values({ id: identity.tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: identity.tenantId, name: "P" })
      .execute();
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "private-customizations-"),
    );
    folder = path.join(directory, "plain-folder");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "notes.txt"), "User content");
    const roots = async () => folder;
    const manager = new ProjectManager(
      new FsBackend(path.join(directory, "copies"), roots),
      new FsRemoteBackend(path.join(directory, "origins")),
      roots,
    );
    const provider = sandboxes.track(
      new LocalProcessSandboxProvider({
        root: path.join(directory, "sandboxes"),
      }),
    );
    core = new CatamorphicCore({
      db,
      triggerKinds: [
        {
          name: "private.sync",
          configJsonSchema: { type: "object" },
          payloadJsonSchema: { type: "object" },
          validateConfig: () => ({ ok: true }),
          validatePayload: () => ({ ok: true }),
        },
        {
          name: "schedule",
          configJsonSchema: { type: "object" },
          payloadJsonSchema: { type: "object" },
          validateConfig: () => ({ ok: true }),
          validatePayload: () => ({ ok: true }),
        },
      ],
      projectManager: manager,
      environmentProvider: testEnvironmentProvider(provider),
      sandboxProvider: provider,
      resolveMemberIdentity: async ({ externalUserId }) =>
        externalUserId === "member-owner" ? liveMember : identity,
      notificationTransport: {
        send: async (event) => {
          alerts.push(event.title);
          notificationKinds.push(event.kind);
        },
      },
    });
  });
  afterAll(async () => {
    await core?.runs.stopWorkers();
    await sandboxes.cleanup();
    await db.destroy();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("partitions state by owner, fences concurrent writers and retains deleted versions", async () => {
    const address = { identity, projectId, key: "todos/list" };
    expect(await core.privateState.read(address)).toEqual({
      key: "todos/list",
      version: 0,
      value: null,
    });
    const written = await core.privateState.write({
      ...address,
      value: { tasks: [] },
      ifVersion: 0,
    });
    const results = await Promise.allSettled(
      [1, 2].map((count) =>
        core.privateState.write({
          ...address,
          ifVersion: written.version,
          value: { count },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(DocumentConflictError) });
    expect(
      (
        await core.privateState.read({
          ...address,
          identity: { ...identity, externalUserId: "another-member" },
        })
      ).version,
    ).toBe(0);
    expect(
      await core.documents.list({ identity, projectId, source: "store" }),
    ).toEqual([]);
    await expect(
      fs.access(
        path.join(folder, ".work", "app-data", "store", "todos", "list.json"),
      ),
    ).rejects.toThrow();
    const current = await core.privateState.read(address);
    const deleted = await core.privateState.delete({
      ...address,
      ifVersion: current.version,
    });
    expect(await core.privateState.read(address)).toEqual({
      key: "todos/list",
      version: deleted.version,
      value: null,
    });
    await expect(
      core.privateState.write({ ...address, value: {}, ifVersion: 0 }),
    ).rejects.toBeInstanceOf(DocumentConflictError);
    await expect(
      core.privateState.read({
        ...address,
        identity: { ...identity, scope: [] },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      core.privateState.read({
        ...address,
        identity: { ...identity, externalUserId: "catamorphic:project" },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("returns a consistent missing or deleted head across concurrent creates and resurrections", async () => {
    const address = { identity, projectId, key: "races/head" };
    const original = core.documents.head.bind(core.documents);
    const head = vi.spyOn(core.documents, "head");
    try {
      head.mockImplementationOnce(async (input) => {
        const snapshot = await original(input);
        await core.privateState.write({
          ...address,
          value: { unseen: true },
          ifVersion: 0,
        });
        return snapshot;
      });
      const missing = await core.privateState.read(address);
      expect(missing).toEqual({ key: address.key, version: 0, value: null });
      await expect(
        core.privateState.write({
          ...address,
          value: {},
          ifVersion: missing.version,
        }),
      ).rejects.toBeInstanceOf(DocumentConflictError);
      const deleted = await core.privateState.delete({
        ...address,
        ifVersion: 1,
      });
      head.mockImplementationOnce(async (input) => {
        const snapshot = await original(input);
        await core.privateState.write({
          ...address,
          value: { resurrected: true },
          ifVersion: deleted.version,
        });
        return snapshot;
      });
      const tombstone = await core.privateState.read(address);
      expect(tombstone).toEqual({
        key: address.key,
        version: deleted.version,
        value: null,
      });
      await expect(
        core.privateState.write({
          ...address,
          value: {},
          ifVersion: tombstone.version,
        }),
      ).rejects.toBeInstanceOf(DocumentConflictError);
    } finally {
      head.mockRestore();
    }
  });

  it("round trips JSON above the document inline text limit", async () => {
    const address = { identity, projectId, key: "large-json" };
    const value = { text: "x".repeat(2 * 1024 * 1024 + 100) };
    await core.privateState.write({ ...address, value, ifVersion: 0 });
    const read = await core.privateState.read(address);
    expect(read.version).toBe(1);
    expect(read.value).toEqual(value);
  });

  it("retains private source without a chat or a Git repository and delivers through the normal run worker", async () => {
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "reminders",
      source: workflow,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    expect(artifact.sessionId).toBeNull();
    expect(
      (await core.sessionArtifacts.files(address))[artifact.sourcePath],
    ).toBe(workflow);
    await expect(fs.access(path.join(folder, ".git"))).rejects.toThrow();
    const preview = await core.privateWorkflows.preview({
      ...address,
      revision: 1,
    });
    const enabled = await core.privateWorkflows.activate({
      ...address,
      revision: 1,
      consentDigest: preview.consentDigest,
    });
    expect(enabled.temporary).toBe(false);
    const activeTrigger = enabled.triggers[0]?.id;
    const repeated = await core.privateWorkflows.activate({
      ...address,
      revision: 1,
      consentDigest: preview.consentDigest,
    });
    expect(repeated.triggers[0]?.id).toBe(activeTrigger);
    await core.schedules.tick({ identity, projectId });
    const scheduled = await db
      .selectFrom("workflow_runs")
      .selectAll()
      .where("session_artifact_id", "=", artifact.id)
      .execute();
    expect(scheduled).toHaveLength(1);
    const run = scheduled[0];
    if (!run) throw new Error("Schedule did not enroll a run");
    const result = await core.runs.driveInline({
      tenantId: identity.tenantId,
      runId: run.id,
      deadline: Date.now() + 30_000,
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(await core.notifications.drain("native-test")).toBe(1);
    expect(alerts).toEqual(["Review today"]);
    expect(notificationKinds).toEqual(["customization"]);
    const revised = await core.sessionArtifacts.update({
      ...address,
      revision: 1,
      files: {
        [artifact.sourcePath]: workflow.replace(
          "Review today",
          "Review tomorrow",
        ),
      },
    });
    expect(
      (
        await core.workflowEnablements.get({
          identity,
          enablementId: enabled.id,
        })
      ).commitSha,
    ).toBe(artifact.commitSha);
    expect(
      (
        await core.sessionArtifacts.files({
          ...address,
          commitSha: artifact.commitSha,
        })
      )[artifact.sourcePath],
    ).toBe(workflow);
    const next = await core.privateWorkflows.preview({
      ...address,
      revision: revised.revision,
    });
    await core.privateWorkflows.activate({
      ...address,
      revision: revised.revision,
      consentDigest: next.consentDigest,
    });
    expect(
      (
        await core.workflowEnablements.get({
          identity,
          enablementId: enabled.id,
        })
      ).commitSha,
    ).toBe(revised.commitSha);
    await core.privateWorkflows.stop(address);
    expect(
      (
        await core.workflowEnablements.get({
          identity,
          enablementId: enabled.id,
        })
      ).status,
    ).toBe("disabled");
    await expect(
      core.runs.get({
        identity: { ...identity, externalUserId: "another-member" },
        runId: run.id,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await core.sessionArtifacts.cleanup();
    expect(
      (await core.sessionArtifacts.files(address))[artifact.sourcePath],
    ).toContain("Review tomorrow");
    await expect(fs.access(path.join(folder, ".git"))).rejects.toThrow();
  });

  it("preserves private ownership through ordinary enablement APIs without a branch hint and supports reinstall", async () => {
    const name = "pinOnly";
    const source = workflow.replaceAll("reminders", name);
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name,
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const input = {
      identity,
      projectId,
      workflowName: name,
      commitSha: artifact.commitSha,
    };
    const preview = await core.workflowEnablements.preview(input);
    expect(preview.remoteBranch).toBe(artifact.remoteBranch);
    const enabled = await core.workflowEnablements.create({
      ...input,
      consentDigest: preview.consentDigest,
    });
    expect(
      await core.privateWorkflows.hasEnabled({ identity, projectId }),
    ).toBe(true);
    await core.schedules.tick({ identity, projectId });
    const run = await db
      .selectFrom("workflow_runs")
      .where("workflow_enablement_id", "=", enabled.id)
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(run.session_artifact_id).toBe(artifact.id);
    const owner: Identity = {
      ...identity,
      scope: [{ kind: "workflow", projectId, name }],
    };
    expect(
      (
        await core.runs.list({ identity: owner, projectId, workflowName: name })
      ).items.map((item) => item.id),
    ).toContain(run.id);
    const foreign: Identity = {
      ...identity,
      externalUserId: "other-admin",
      scope: [{ kind: "workflow", projectId, name }],
      projectPermissions: [
        { projectId, permission: "runs:read" },
        { projectId, permission: "runs:write" },
      ],
    };
    for (const caller of [
      { ...identity, scope: [] },
      foreign,
      { ...identity, externalUserId: "other-root" },
    ]) {
      await expect(
        core.runs.listItems({
          identity: caller,
          runId: run.id,
          workflowStepAttemptId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.runs.listItemSteps({
          identity: caller,
          runId: run.id,
          workflowStepAttemptId: randomUUID(),
          itemId: "private-item",
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.runs.pause({ identity: caller, runId: run.id }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.runs.resume({ identity: caller, runId: run.id }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.runs.resumePause({
          identity: caller,
          runId: run.id,
          pauseId: randomUUID(),
          idempotencyKey: "other",
          value: {},
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      if (!run.correlation_key)
        throw new Error("Missing schedule correlation key");
      await expect(
        core.runs.signalByKey({
          identity: caller,
          projectId,
          workflowName: name,
          runId: run.id,
          correlationKey: run.correlation_key,
          signal: "resume",
          idempotencyKey: "other",
          value: {},
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(
      (
        await db
          .selectFrom("workflow_runs")
          .where("id", "=", run.id)
          .select("status")
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("pending");
    await core.privateWorkflows.stop(address);
    expect(
      (
        await core.workflowEnablements.get({
          identity,
          enablementId: enabled.id,
        })
      ).status,
    ).toBe("disabled");
    expect(await core.privateWorkflows.hasEnabled({ identity })).toBe(false);
    await core.sessionArtifacts.discard(address);
    await expect(
      core.workflowEnablements.preview(input),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      core.runs.triggerAtCommit({ ...input, remoteBranch: "main", input: {} }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const replacement = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name,
      source,
    });
    const nextAddress = { identity, projectId, artifactId: replacement.id };
    const nextPreview = await core.privateWorkflows.preview({
      ...nextAddress,
      revision: 1,
    });
    const nextEnabled = await core.privateWorkflows.activate({
      ...nextAddress,
      revision: 1,
      consentDigest: nextPreview.consentDigest,
    });
    expect(nextEnabled.id).toBe(enabled.id);
    await core.sessionArtifacts.discard(address);
    expect(
      (
        await core.workflowEnablements.get({
          identity,
          enablementId: nextEnabled.id,
        })
      ).status,
    ).toBe("active");
    await core.privateWorkflows.stop(nextAddress);
  });

  it("fences an ordinary enablement created while its source is discarded", async () => {
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "activationRace",
      source: workflow.replaceAll("reminders", "activationRace"),
    });
    const input = {
      identity,
      projectId,
      workflowName: artifact.name,
      commitSha: artifact.commitSha,
    };
    const preview = await core.workflowEnablements.preview(input);
    const original = core.workflowEnablements.preview.bind(
      core.workflowEnablements,
    );
    const readPreview = vi
      .spyOn(core.workflowEnablements, "preview")
      .mockImplementationOnce(async (args) => {
        const value = await original(args);
        await core.sessionArtifacts.discard({
          identity,
          projectId,
          artifactId: artifact.id,
        });
        return value;
      });
    try {
      await expect(
        core.workflowEnablements.create({
          ...input,
          consentDigest: preview.consentDigest,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    } finally {
      readPreview.mockRestore();
    }
    expect(
      await db
        .selectFrom("workflow_enablements")
        .where("commit_sha", "=", artifact.commitSha)
        .select("id")
        .execute(),
    ).toEqual([]);
  });

  it("keeps an approved one-off private run visible to the background lifetime query", async () => {
    const source = `import { defineWorkflow, type BoundaryContext } from "@catamorphic/workflow"; export const backgroundOnce = defineWorkflow(({ defineBoundary }) => ({ steps: [defineBoundary({ run: ({ input }: BoundaryContext<{}>) => input })] }));`;
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "backgroundOnce",
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    expect(await core.privateWorkflows.hasEnabled({ identity })).toBe(false);
    await core.privateWorkflows.run({ ...address, revision: 1 });
    expect(await core.privateWorkflows.hasEnabled({ identity })).toBe(true);
    expect(
      await core.privateWorkflows.hasEnabled({
        identity: { ...identity, externalUserId: "other-member" },
      }),
    ).toBe(false);
    expect(
      await core.privateWorkflows.hasEnabled({
        identity: { ...identity, scope: [] },
      }),
    ).toBe(false);
    await core.privateWorkflows.stop(address);
    expect(await core.privateWorkflows.hasEnabled({ identity })).toBe(false);
  });

  it("identifies the run's exact retained revision after edits and same-content updates", async () => {
    const name = "pollIdentity";
    const source = `import { defineWorkflow, type BoundaryContext } from "@catamorphic/workflow"; export const pollIdentity = defineWorkflow(({ defineBoundary }) => ({ steps: [defineBoundary({ run: ({ input }: BoundaryContext<{}>) => input })] }));`;
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name,
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const first = await core.privateWorkflows.run({ ...address, revision: 1 });
    expect(
      await core.runs.retainedSource({ identity, runId: first.id }),
    ).toEqual({ artifactId: artifact.id, revision: 1, lifetime: "member" });
    const unchanged = await core.sessionArtifacts.update({
      ...address,
      revision: 1,
      files: { [artifact.sourcePath]: source },
    });
    expect(unchanged.commitSha).not.toBe(artifact.commitSha);
    const second = await core.privateWorkflows.run({ ...address, revision: 2 });
    await core.sessionArtifacts.update({
      ...address,
      revision: 2,
      files: {
        [artifact.sourcePath]: source.replace(
          "=> input",
          "=> ({ changed: true })",
        ),
      },
    });
    expect(
      await core.runs.retainedSource({ identity, runId: first.id }),
    ).toEqual({ artifactId: artifact.id, revision: 1, lifetime: "member" });
    expect(
      await core.runs.retainedSource({ identity, runId: second.id }),
    ).toEqual({ artifactId: artifact.id, revision: 2, lifetime: "member" });
    await expect(
      core.runs.retainedSource({
        identity: { ...identity, externalUserId: "other-member" },
        runId: first.id,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      core.runs.retainedSource({
        identity: { ...identity, scope: [] },
        runId: first.id,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const publicRun = await db
      .insertInto("workflow_runs")
      .values({
        project_id: projectId,
        workflow_name: "publicWorkflow",
        external_user_id: identity.externalUserId,
        status: "completed",
        completed_at: new Date(),
        phase: "boundary",
        provenance: {},
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(
      await core.runs.retainedSource({ identity, runId: publicRun.id }),
    ).toBeNull();
    await core.privateWorkflows.stop(address);
  });

  it("keeps caller-facing sync triggers private before enrollment and through cached source reads", async () => {
    const name = "privateSync";
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name,
      source: `import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
export const privateSync = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("private.sync")],
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{}>) => ({ secret: "owner-only" }) })]
}));`,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const preview = await core.privateWorkflows.preview({
      ...address,
      revision: 1,
    });
    const enabled = await core.privateWorkflows.activate({
      ...address,
      revision: 1,
      consentDigest: preview.consentDigest,
    });
    const fire = {
      projectId,
      kind: "private.sync",
      payload: {},
      mode: "sync" as const,
      workflows: [name],
    };
    const pinned = {
      ...fire,
      commitSha: artifact.commitSha,
      remoteBranch: artifact.remoteBranch,
    };
    const count = () =>
      db
        .selectFrom("workflow_runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("project_id", "=", projectId)
        .where("workflow_name", "=", name)
        .executeTakeFirstOrThrow();
    const before = await count();
    for (const caller of [
      { ...identity, externalUserId: "foreign-root" },
      {
        ...identity,
        externalUserId: "foreign-member",
        scope: [{ kind: "workflow" as const, projectId, name }],
      },
      { ...identity, scope: [] },
    ]) {
      await expect(
        core.triggers.fire({ ...fire, identity: caller }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.triggers.fireAtCommit({ ...pinned, identity: caller }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.triggers.listAtCommit({ ...pinned, identity: caller }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(await count()).toEqual(before);
    }
    const hidden = await core.triggers.fire({
      identity: { ...identity, externalUserId: "foreign-root" },
      projectId,
      kind: "private.sync",
      payload: {},
      mode: "sync",
    });
    expect(hidden.runs).toEqual([]);
    expect(await count()).toEqual(before);
    const owned = await core.triggers.fire({ ...fire, identity });
    expect(owned.runs).toEqual([
      expect.objectContaining({
        status: "completed",
        output: { secret: "owner-only" },
      }),
    ]);
    const dispatched = await core.triggers.dispatchAtCommit({
      ...pinned,
      identity: { ...identity, externalUserId: "host-dispatcher" },
      enablementIds: [enabled.id],
    });
    expect(dispatched.runs).toEqual([
      expect.objectContaining({
        status: "completed",
        output: { secret: "owner-only" },
      }),
    ]);
    await core.privateWorkflows.stop(address);
  });

  it("keeps retained enablement metadata and controls private across source revisions", async () => {
    const name = "privateMetadata";
    const source = `import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
export const privateMetadata = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("private.sync", { title: "Personal reminder detail" })],
  steps: [defineBoundary({ run: ({ input }: BoundaryContext<{}>) => input })]
}));`;
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name,
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const preview = await core.privateWorkflows.preview({
      ...address,
      revision: 1,
    });
    const enabled = await core.privateWorkflows.activate({
      ...address,
      revision: 1,
      consentDigest: preview.consentDigest,
    });
    await core.sessionArtifacts.update({
      ...address,
      revision: 1,
      files: { [artifact.sourcePath]: `${source}\n// Next private revision\n` },
    });
    for (const caller of [
      { ...identity, externalUserId: "foreign-root" },
      {
        ...identity,
        externalUserId: "foreign-admin",
        scope: [{ kind: "workflow" as const, projectId, name }],
        projectPermissions: [
          { projectId, permission: "automations:read" },
          { projectId, permission: "automations:write" },
        ],
      },
      { ...identity, scope: [] },
    ]) {
      const input = { identity: caller, enablementId: enabled.id };
      await expect(core.workflowEnablements.get(input)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      expect(
        await core.workflowEnablements.list({
          identity: caller,
          projectId,
          includeAll: true,
        }),
      ).not.toContainEqual(expect.objectContaining({ id: enabled.id }));
      await expect(
        core.workflowEnablements.disable(input),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.workflowEnablements.reenable(input),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        core.workflowEnablements.updateDeployment({
          ...input,
          commitSha: enabled.commitSha,
          consentDigest: enabled.consentDigest,
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    const current = await core.workflowEnablements.get({
      identity,
      enablementId: enabled.id,
    });
    expect(current).toMatchObject({
      status: "active",
      revision: enabled.revision,
    });
    expect(current.triggers[0]?.config).toEqual({
      title: "Personal reminder detail",
    });
    expect(
      await core.workflowEnablements.list({
        identity,
        projectId,
        includeAll: true,
      }),
    ).toContainEqual(expect.objectContaining({ id: enabled.id }));
    await core.privateWorkflows.stop(address);
  });

  it("rechecks live member authority before a queued workflow can notify", async () => {
    const member = liveMember;
    if (!member) throw new Error("Missing test member");
    const artifact = await core.sessionArtifacts.create({
      identity: member,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "revoked",
      source: workflow
        .replaceAll("reminders", "revoked")
        .replace("reminder:1", "revoked:1"),
    });
    const address = { identity: member, projectId, artifactId: artifact.id };
    const preview = await core.privateWorkflows.preview({
      ...address,
      revision: 1,
    });
    const enabled = await core.privateWorkflows.activate({
      ...address,
      revision: 1,
      consentDigest: preview.consentDigest,
    });
    const run = await core.runs.triggerWithEnablement({
      identity: member,
      projectId,
      workflowName: "revoked",
      enablementId: enabled.id,
      input: {
        activationId: randomUUID(),
        scheduledFor: new Date().toISOString(),
        firedAt: new Date().toISOString(),
      },
    });
    const context = {
      caller: member,
      projectId,
      runId: run.id,
      workflowName: "revoked",
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(await core.authorizeWorkflowHostCall(context)).toEqual(member);
    liveMember = { ...member, projectPermissions: [] };
    await expect(core.authorizeWorkflowHostCall(context)).rejects.toThrow();
    const result = await core.runs.driveInline({
      tenantId: identity.tenantId,
      runId: run.id,
      deadline: Date.now() + 30_000,
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(
      (
        await core.workflowEnablements.get({
          identity: member,
          enablementId: enabled.id,
        })
      ).suspensionReason,
    ).toBe("permission_revoked");
    const events = await db
      .selectFrom("user_notification_events")
      .select("id")
      .where("external_user_id", "=", member.externalUserId)
      .execute();
    expect(events).toEqual([]);
  });

  it("rejects later host effects when the same run's enablement is disabled", async () => {
    const artifact = await core.sessionArtifacts.create({
      identity,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "hostAuthority",
      source: workflow.replaceAll("reminders", "hostAuthority"),
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const preview = await core.privateWorkflows.preview({
      ...address,
      revision: 1,
    });
    const enabled = await core.privateWorkflows.activate({
      ...address,
      revision: 1,
      consentDigest: preview.consentDigest,
    });
    const run = await core.runs.triggerWithEnablement({
      identity,
      projectId,
      workflowName: "hostAuthority",
      enablementId: enabled.id,
      input: {
        activationId: randomUUID(),
        scheduledFor: new Date().toISOString(),
        firedAt: new Date().toISOString(),
      },
    });
    const context = {
      caller: identity,
      projectId,
      runId: run.id,
      workflowName: "hostAuthority",
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    expect(await core.authorizeWorkflowHostCall(context)).toEqual(identity);
    await core.workflowEnablements.disable({
      identity,
      enablementId: enabled.id,
    });
    await expect(core.authorizeWorkflowHostCall(context)).rejects.toThrow();
    await core.privateWorkflows.stop(address);
  });

  it("composes a private static child under the parent's source grant", async () => {
    const member: Identity = {
      ...identity,
      externalUserId: "member-owner",
      scope: [{ kind: "workflow", projectId, name: "parentPrivate" }],
      executionScope: [{ projectId, name: "default" }],
      projectPermissions: [{ projectId, permission: "notifications:write" }],
    };
    liveMember = member;
    const source = `import { defineWorkflow, type BoundaryContext } from "@catamorphic/workflow";
export const privateChild = defineWorkflow(({ defineBoundary }) => ({ permissions: ["notifications:write"], steps: [defineBoundary({ run: ({ host }: BoundaryContext<{}>) => host["catamorphic.notifications"].publish({ title: "Child reminder", idempotencyKey: "child-reminder" }) })] }));
export const parentPrivate = defineWorkflow(({ defineBoundary }) => ({ permissions: ["notifications:write"], steps: [defineBoundary({ run: ({ callWorkflow }: BoundaryContext<{}>) => callWorkflow(privateChild, { input: {} }) })] }));`;
    const artifact = await core.sessionArtifacts.create({
      identity: member,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "parentPrivate",
      source,
    });
    const run = await core.privateWorkflows.run({
      identity: member,
      projectId,
      artifactId: artifact.id,
      revision: 1,
      input: {},
    });
    expect(
      await core.runs.driveInline({
        tenantId: identity.tenantId,
        runId: run.id,
        deadline: Date.now() + 30_000,
      }),
    ).toMatchObject({ status: "suspended", suspendedOn: "child" });
    const child = await db
      .selectFrom("workflow_runs")
      .where("parent_run_id", "=", run.id)
      .select("id")
      .executeTakeFirstOrThrow();
    expect(
      await core.runs.driveInline({
        tenantId: identity.tenantId,
        runId: child.id,
        deadline: Date.now() + 30_000,
      }),
    ).toMatchObject({ status: "completed" });
    const children = await db
      .selectFrom("workflow_runs")
      .where("parent_run_id", "=", run.id)
      .select(["status", "session_artifact_id"])
      .execute();
    expect(children).toEqual([
      { status: "completed", session_artifact_id: artifact.id },
    ]);
  });

  it("retries an undelivered notification after its transport restarts", async () => {
    const failing = new UserNotificationsService(db, undefined, {
      send: async () => {
        throw new Error("Transport offline");
      },
    });
    await failing.notify({
      identity,
      projectId,
      title: "Persisted reminder",
      idempotencyKey: "retry-after-restart",
    });
    await failing.drain("native-retry");
    const receipt = await db
      .selectFrom("notification_host_deliveries as delivery")
      .innerJoin(
        "user_notification_events as event",
        "event.id",
        "delivery.event_id",
      )
      .where("event.title", "=", "Persisted reminder")
      .select([
        "delivery.event_id",
        "delivery.status",
        "delivery.attempt_count",
      ])
      .executeTakeFirstOrThrow();
    expect(receipt).toMatchObject({ status: "pending", attempt_count: 1 });
    await db
      .updateTable("notification_host_deliveries")
      .set({ next_attempt_at: new Date(0) })
      .where("event_id", "=", receipt.event_id)
      .execute();
    const resumed = new UserNotificationsService(db, undefined, {
      send: async (event) => {
        alerts.push(event.title);
      },
    });
    expect(await resumed.drain("native-restarted")).toBe(1);
    expect(
      alerts.filter((title) => title === "Persisted reminder"),
    ).toHaveLength(1);
    expect(await resumed.drain("native-restarted")).toBe(0);
  });

  it("deduplicates notifications and rejects missing permission without a model turn", async () => {
    const event = {
      identity,
      projectId,
      title: "Reminder",
      idempotencyKey: "durable-reminder",
    };
    await core.notifications.notify(event);
    await core.notifications.notify(event);
    expect(await core.notifications.drain("native-test")).toBe(1);
    expect(alerts.filter((title) => title === "Reminder")).toHaveLength(1);
    await expect(
      core.notifications.notify({
        ...event,
        identity: { ...identity, scope: [] },
        idempotencyKey: "denied",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await db.selectFrom("agent_turns").select("id").execute()).toEqual(
      [],
    );
  });
});
