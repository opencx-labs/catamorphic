import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import {
  CheckoutRemoteBackend,
  FsBackend,
  FsRemoteBackend,
  type OriginRepo,
  ProjectManager,
} from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionArtifactsService } from "../services/session-artifacts-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const suite = connectionString ? describe : describe.skip;
const schema = `artifacts_${randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 1 });
const identity = { tenantId: randomUUID(), externalUserId: "owner" };
const projectId = randomUUID();
const sessionId = randomUUID();
let rejectPublication = false;
let afterPublication: (() => Promise<void>) | undefined;
class PublicationBackend extends FsRemoteBackend {
  override async withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T> {
    const result = await super.withOrigin(tenantId, projectId, fn);
    if (
      typeof result === "object" &&
      result !== null &&
      "commitSha" in result
    ) {
      await afterPublication?.();
      if (rejectPublication) throw new Error("Remote publication failed");
    }
    return result;
  }
}
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
      // Desktop storage resolves project paths through its single-connection DB.
      // Artifact updates must resolve it before locking a revision in a transaction.
      new CheckoutRemoteBackend(
        async () => {
          await sql`select 1`.execute(db);
          return null;
        },
        new PublicationBackend(path.join(directory, "origin")),
      ),
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

  it("updates an existing flat ref without colliding with its git namespace", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "existing-ref",
      source,
    });
    const remote = manager.remoteBackend;
    if (!remote) throw new Error("Missing origin");
    const originalBranch = `catamorphic/artifacts/${artifact.id}`;
    await remote.withOrigin(identity.tenantId, projectId, async (origin) => {
      await origin.updateRef({
        ref: `refs/heads/${originalBranch}`,
        sha: artifact.commitSha,
      });
      await origin.deleteRef({ ref: `refs/heads/${artifact.remoteBranch}` });
    });
    await db
      .updateTable("session_artifacts")
      .set({ remote_branch: originalBranch })
      .where("id", "=", artifact.id)
      .execute();
    const address = { identity, projectId, artifactId: artifact.id };
    const updated = await artifacts.update({
      ...address,
      revision: 1,
      files: { [artifact.sourcePath]: source.replace("First", "Second") },
    });
    expect(updated.revision).toBe(2);
    expect((await artifacts.files(address))[artifact.sourcePath]).toContain(
      "Second",
    );
    expect(
      (await artifacts.files({ ...address, commitSha: artifact.commitSha }))[
        artifact.sourcePath
      ],
    ).toBe(source);
    await artifacts.discard(address);
    await artifacts.cleanup();
    await remote.withOrigin(identity.tenantId, projectId, async (origin) => {
      expect(
        await origin.resolveRef(`refs/heads/${originalBranch}`),
      ).toBeNull();
      expect(
        await origin.resolveRef(`refs/heads/${updated.remoteBranch}`),
      ).toBeNull();
      expect(await origin.resolveRef("refs/heads/main")).not.toBeNull();
    });
  });

  it("rolls back a revision when buffered remote publication fails, then recovers", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "publication",
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    rejectPublication = true;
    try {
      await expect(
        artifacts.update({
          ...address,
          revision: 1,
          files: { [artifact.sourcePath]: source.replace("First", "Rejected") },
        }),
      ).rejects.toThrow("Remote publication failed");
    } finally {
      rejectPublication = false;
    }
    expect((await artifacts.get(address)).revision).toBe(1);
    const recovered = await artifacts.update({
      ...address,
      revision: 1,
      files: { [artifact.sourcePath]: source.replace("First", "Recovered") },
    });
    expect(recovered.revision).toBe(2);
    expect((await artifacts.files(address))[artifact.sourcePath]).toContain(
      "Recovered",
    );
  });

  it("leaves the single database connection free during remote publication", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "nonblocking",
      source,
    });
    afterPublication = async () => {
      await sql`select 1`.execute(db);
      expect(
        (await artifacts.get({ identity, projectId, artifactId: artifact.id }))
          .revision,
      ).toBe(1);
    };
    try {
      const updated = await artifacts.update({
        identity,
        projectId,
        artifactId: artifact.id,
        revision: 1,
        files: { [artifact.sourcePath]: source.replace("First", "Second") },
      });
      expect(updated.revision).toBe(2);
      expect(updated.remoteBranch).not.toBe(artifact.remoteBranch);
    } finally {
      afterPublication = undefined;
    }
  });

  it("fences concurrent candidates without rewinding the accepted ref", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "concurrent",
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    let release = () => {};
    let published = () => {};
    const ready = new Promise<void>((resolve) => {
      published = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterPublication = async () => {
      afterPublication = undefined;
      published();
      await gate;
    };
    const first = artifacts.update({
      ...address,
      revision: 1,
      files: { [artifact.sourcePath]: source.replace("First", "Loser") },
    });
    const rejected = expect(first).rejects.toThrow("Artifact changed");
    try {
      await ready;
      const winner = await artifacts.update({
        ...address,
        revision: 1,
        files: { [artifact.sourcePath]: source.replace("First", "Winner") },
      });
      release();
      await rejected;
      expect((await artifacts.get(address)).commitSha).toBe(winner.commitSha);
      expect((await artifacts.files(address))[artifact.sourcePath]).toContain(
        "Winner",
      );
      expect(
        (await artifacts.files({ ...address, commitSha: artifact.commitSha }))[
          artifact.sourcePath
        ],
      ).toBe(source);
    } finally {
      afterPublication = undefined;
      release();
      await rejected;
    }
  });

  it("reclaims a candidate published after discard already swept its refs", async () => {
    const artifact = await artifacts.create({
      identity,
      projectId,
      sessionId,
      kind: "app",
      name: "discardrace",
      source,
    });
    const address = { identity, projectId, artifactId: artifact.id };
    afterPublication = async () => {
      afterPublication = undefined;
      await artifacts.discard(address);
      await artifacts.cleanup();
      // A remote worker finishing after the sweep can leave a candidate ref.
      await manager.remoteBackend!.withOrigin(
        identity.tenantId,
        projectId,
        async (origin) => {
          await origin.updateRef({
            ref: `refs/heads/catamorphic/artifacts/${artifact.id}-late`,
            sha: artifact.commitSha,
          });
        },
      );
    };
    try {
      await expect(
        artifacts.update({
          ...address,
          revision: 1,
          files: { [artifact.sourcePath]: source.replace("First", "Late") },
        }),
      ).rejects.toThrow("unavailable");
      const inventory = () =>
        manager.remoteBackend!.withOrigin(
          identity.tenantId,
          projectId,
          (origin) => origin.listRefs("refs/heads/"),
        );
      const prefix = `refs/heads/catamorphic/artifacts/${artifact.id}`;
      const before = await inventory();
      expect(before.some(({ ref }) => ref === `${prefix}-late`)).toBe(true);
      await artifacts.cleanup();
      const refs = await inventory();
      expect(refs.filter(({ ref }) => ref.startsWith(prefix))).toEqual([]);
      expect(refs).toEqual(before.filter(({ ref }) => !ref.startsWith(prefix)));
    } finally {
      afterPublication = undefined;
    }
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
