import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionArtifactsService } from "../services/session-artifacts-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const suite = connectionString ? describe : describe.skip;
const schema = `artifacts_${randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const identity = { tenantId: randomUUID(), externalUserId: "owner" };
const projectId = randomUUID();
const sessionId = randomUUID();
const source =
  "export default function App() { return <p>First revision</p>; }";

suite("session artifact source lifecycle", () => {
  let directory: string;
  let manager: ProjectManager;
  let artifacts: SessionArtifactsService;
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: identity.tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: identity.tenantId, name: "P" })
      .execute();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: identity.externalUserId,
        provider: "test",
      })
      .execute();
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cat-session-artifacts-"),
    );
    manager = new ProjectManager(
      new FsBackend(path.join(directory, "dev")),
      new FsRemoteBackend(path.join(directory, "origin")),
    );
    await manager.create(identity.tenantId, projectId, {
      name: "artifacts",
      externalUserId: identity.externalUserId,
    });
    artifacts = new SessionArtifactsService(db, manager);
  });
  afterAll(async () => {
    await sql`drop schema ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("creates isolated app source without editing or staging the user's files", async () => {
    const repo = await manager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      await repo.writeFile("unrelated.txt", "Do not capture");
      const head = await repo.resolveRef("HEAD");
      const artifact = await artifacts.create({
        identity,
        projectId,
        sessionId,
        kind: "app",
        name: "review",
        source,
      });
      expect(artifact.appName).toBe(`session-${artifact.id}`);
      expect(await repo.resolveRef("HEAD")).toBe(head);
      expect(await repo.listFiles()).not.toContain("apps/review/src/App.tsx");
      const files = await artifacts.files({
        identity,
        projectId,
        artifactId: artifact.id,
      });
      expect(files[artifact.sourcePath]).toBe(source);
      expect(files["unrelated.txt"]).toBeUndefined();
      expect(files["contracts/package.json"]).toContain("@project/contracts");
    } finally {
      await repo.dispose();
    }
  });

  it("keeps immutable versions and rejects stale or cross-user updates", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "review",
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    const updated = await artifacts.update({
      ...address,
      revision: 1,
      files: { [artifact.sourcePath]: source.replace("First", "Second") },
    });
    expect(updated.revision).toBe(2);
    expect(
      (await artifacts.files({ ...address, commitSha: artifact.commitSha }))[
        artifact.sourcePath
      ],
    ).toBe(source);
    expect((await artifacts.files(address))[artifact.sourcePath]).toContain(
      "Second",
    );
    await expect(
      artifacts.update({
        ...address,
        revision: 1,
        files: { [artifact.sourcePath]: "stale" },
      }),
    ).rejects.toThrow("Artifact changed");
    await expect(
      artifacts.get({
        ...address,
        identity: { ...identity, externalUserId: "other" },
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      artifacts.get({ ...address, identity: { ...identity, scope: [] } }),
    ).rejects.toThrow("Not authorized");
  });

  it("uses the same lifecycle for workflows and keeps closed-session results readable", async () => {
    const workflow =
      'import { defineWorkflow } from "@catamorphic/workflow"; export const example = defineWorkflow(({ defineBoundary }) => ({ steps: [defineBoundary({ run: async () => ({ result: 1 }) })] }));';
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "workflow",
      name: "example",
      source: workflow,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    await db
      .updateTable("agent_sessions")
      .set({ status: "closed" })
      .where("id", "=", sessionId)
      .execute();
    expect((await artifacts.files(address))[artifact.sourcePath]).toBe(
      workflow,
    );
    await expect(artifacts.assertActive(address)).rejects.toThrow(
      "Session is closed",
    );
    await artifacts.discard(address);
    await artifacts.discard(address);
    await expect(artifacts.get(address)).rejects.toThrow("unavailable");
    expect(
      (await artifacts.list({ identity, projectId, sessionId })).find(
        (item) => item.id === artifact.id,
      )?.status,
    ).toBe("discarded");
    await db
      .updateTable("agent_sessions")
      .set({ status: "active" })
      .where("id", "=", sessionId)
      .execute();
  });

  it("retains source while an immutable run needs it", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "keep",
      source,
    });
    const deployment = await db
      .insertInto("deployment_artifacts")
      .values({
        project_id: projectId,
        commit_sha: artifact.commitSha,
        artifact_digest: randomUUID(),
        plugin_digest: "none",
        runtime_version: "test",
        transform_version: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const run = await db
      .insertInto("workflow_runs")
      .values({
        project_id: projectId,
        workflow_name: "helper",
        deployment_artifact_id: deployment.id,
        session_artifact_id: artifact.id,
        provenance: { commitSha: artifact.commitSha },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await artifacts.discard({ identity, projectId, artifactId: artifact.id });
    await artifacts.cleanup();
    expect(
      (
        await db
          .selectFrom("session_artifacts")
          .select("ref_deleted_at")
          .where("id", "=", artifact.id)
          .executeTakeFirstOrThrow()
      ).ref_deleted_at,
    ).toBeNull();
    await db
      .updateTable("workflow_runs")
      .set({ status: "completed", completed_at: new Date() })
      .where("id", "=", run.id)
      .execute();
    await artifacts.cleanup();
    expect(
      (
        await db
          .selectFrom("session_artifacts")
          .select("ref_deleted_at")
          .where("id", "=", artifact.id)
          .executeTakeFirstOrThrow()
      ).ref_deleted_at,
    ).not.toBeNull();
  });

  it("rejects ambiguous helper workflow exports in app snapshots", async () => {
    const helper =
      'import { defineWorkflow } from "@catamorphic/workflow"; export const helper = defineWorkflow(({ defineBoundary }) => ({ steps: [defineBoundary({ run: async () => ({ result: 1 }) })] }));';
    await expect(
      artifacts.create({
        identity,
        projectId,
        sessionId,
        kind: "app",
        name: "ambiguous",
        source,
        files: {
          "workflows/src/first.ts": helper,
          "workflows/src/second.ts": helper,
        },
      }),
    ).rejects.toThrow("Workflow export helper is ambiguous");
  });

  it("rejects paths outside the selected source workspace", async () => {
    await expect(
      artifacts.create({
        identity,
        projectId,
        sessionId,
        kind: "app",
        name: "escape",
        source,
        files: { "../outside": "bad" },
      }),
    ).rejects.toThrow("Invalid artifact path");
    await expect(
      artifacts.create({
        identity,
        projectId,
        sessionId,
        kind: "app",
        name: "escape",
        source,
        files: { ".git/config": "bad" },
      }),
    ).rejects.toThrow("Invalid artifact path");
  });
  it("removes selected files without changing older snapshots", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "cleanup",
      source,
      files: { "apps/cleanup/src/unused.ts": "export const old = true" },
    });
    const address = { identity, projectId, artifactId: artifact.id };
    await artifacts.update({
      ...address,
      revision: 1,
      files: { "apps/cleanup/src/unused.ts": null },
    });
    expect(
      (await artifacts.files(address))["apps/cleanup/src/unused.ts"],
    ).toBeUndefined();
    expect(
      (await artifacts.files({ ...address, commitSha: artifact.commitSha }))[
        "apps/cleanup/src/unused.ts"
      ],
    ).toContain("old");
  });
});
