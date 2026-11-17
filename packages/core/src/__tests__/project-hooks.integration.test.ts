import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import type { Project } from "../services/projects-service.js";
import {
  ProjectNotFoundError,
  ProjectProvisioningError,
} from "../services/projects-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_hooks_${crypto.randomUUID().replaceAll("-", "")}`;

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "alice",
};

describeIf("Project lifecycle hooks (ADRs 0046, 0331)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let projectManager: ProjectManager;
  const provisioned: string[] = [];
  const deprovisioned: string[] = [];
  let failNextCreate = false;
  let failNextDelete = false;
  let pendingDeletes = 0;
  let mintedSecrets: Record<string, string> | undefined;

  function coreWithHooks(): CatamorphicCore {
    return new CatamorphicCore({
      db,
      projectManager,
      environmentProvider: testEnvironmentProvider(),
      credentialVault: new MemoryCredentialVault(),
      projectHooks: [
        {
          onProjectCreated: ({ project }: { project: Project }) => {
            if (failNextCreate) {
              failNextCreate = false;
              throw new Error("provisioning outage");
            }
            provisioned.push(project.id);
            return mintedSecrets ? { secrets: mintedSecrets } : undefined;
          },
          onProjectDeleted: ({ project }: { project: Project }) => {
            if (failNextDelete) {
              failNextDelete = false;
              throw new Error("deprovisioning outage");
            }
            if (pendingDeletes > 0) {
              pendingDeletes -= 1;
              return { done: false };
            }
            deprovisioned.push(project.id);
            return { done: true };
          },
        },
      ],
    });
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-hooks-"));
    const devDir = path.join(tmpDir, "dev");
    const originDir = path.join(tmpDir, "origin");
    await fs.mkdir(devDir, { recursive: true });
    await fs.mkdir(originDir, { recursive: true });
    projectManager = new ProjectManager(
      new FsBackend(devDir),
      new FsRemoteBackend(originDir),
    );
    db = createDatabase({ connectionString, schema, poolSize: 4 });
    await migrateToLatest({ db, schema });
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs onProjectCreated after the project exists", async () => {
    const core = coreWithHooks();
    const project = await core.projects.create(identity, { name: "ok" });
    expect(provisioned).toContain(project.id);
    await core.projects.delete(identity, project.id);
  });

  it("rolls the create back when provisioning fails", async () => {
    const core = coreWithHooks();
    failNextCreate = true;
    await expect(
      core.projects.create(identity, { name: "doomed" }),
    ).rejects.toThrow(ProjectProvisioningError);

    const rows = await db
      .selectFrom("projects")
      .where("tenant_id", "=", identity.tenantId)
      .where("name", "=", "doomed")
      .select("id")
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("keeps the secrets a create hook returns as project secrets", async () => {
    const core = coreWithHooks();
    mintedSecrets = { DATABASE_URL: "postgres://project-role@db/app" };
    try {
      const project = await core.projects.create(identity, { name: "db" });
      await expect(
        core.secrets?.value({
          tenantId: identity.tenantId,
          projectId: project.id,
          name: "DATABASE_URL",
        }),
      ).resolves.toBe("postgres://project-role@db/app");
      const row = await db
        .selectFrom("project_secrets")
        .select(["set_by", "member_external_user_id"])
        .where("project_id", "=", project.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ set_by: "host", member_external_user_id: null });
      await core.projects.delete(identity, project.id);
    } finally {
      mintedSecrets = undefined;
    }
  });

  it("refuses a create whose hook returns a name Work reserves", async () => {
    const core = coreWithHooks();
    mintedSecrets = { WORK_TOKEN: "x" };
    try {
      await expect(
        core.projects.create(identity, { name: "reserved" }),
      ).rejects.toThrow(ProjectProvisioningError);
    } finally {
      mintedSecrets = undefined;
    }
  });

  it("deletes the project and retries a failed cleanup until it is done", async () => {
    const core = coreWithHooks();
    const project = await core.projects.create(identity, { name: "sticky" });

    failNextDelete = true;
    pendingDeletes = 1;
    await core.projects.delete(identity, project.id);
    await expect(core.projects.get(identity, project.id)).rejects.toThrow(
      ProjectNotFoundError,
    );
    expect(deprovisioned).not.toContain(project.id);
    const due = () =>
      db
        .updateTable("project_cleanups")
        .set({ next_attempt_at: new Date(Date.now() - 1_000) })
        .where("project_id", "=", project.id)
        .execute();
    const cleanup = () =>
      db
        .selectFrom("project_cleanups")
        .select(["attempts", "last_error"])
        .where("project_id", "=", project.id)
        .executeTakeFirst();
    await expect(cleanup()).resolves.toEqual({
      attempts: 1,
      last_error: "deprovisioning outage",
    });
    // Not due yet: nothing is called.
    await expect(core.projects.retryCleanups()).resolves.toBe(0);

    // Still underway: kept, with backoff.
    await due();
    await expect(core.projects.retryCleanups()).resolves.toBe(0);
    await expect(cleanup()).resolves.toEqual({ attempts: 2, last_error: null });

    await due();
    await expect(core.projects.retryCleanups()).resolves.toBe(1);
    expect(deprovisioned).toContain(project.id);
    await expect(cleanup()).resolves.toBeUndefined();
  });
});
