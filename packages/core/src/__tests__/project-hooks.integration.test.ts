import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import type { Project } from "../services/projects-service.js";
import {
  ProjectDeprovisioningError,
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

describeIf("Project lifecycle hooks (ADR 0046)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let projectManager: ProjectManager;
  const provisioned: string[] = [];
  const deprovisioned: string[] = [];
  let failNextCreate = false;
  let failNextDelete = false;

  function coreWithHooks(): CatamorphicCore {
    return new CatamorphicCore({
      db,
      projectManager,
      environmentProvider: testEnvironmentProvider(),
      projectHooks: [
        {
          onProjectCreated: ({ project }: { project: Project }) => {
            if (failNextCreate) {
              failNextCreate = false;
              throw new Error("provisioning outage");
            }
            provisioned.push(project.id);
          },
          onProjectDeleted: ({ project }: { project: Project }) => {
            if (failNextDelete) {
              failNextDelete = false;
              throw new Error("deprovisioning outage");
            }
            deprovisioned.push(project.id);
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

  it("aborts the delete when deprovisioning fails, and retries cleanly", async () => {
    const core = coreWithHooks();
    const project = await core.projects.create(identity, { name: "sticky" });

    failNextDelete = true;
    await expect(core.projects.delete(identity, project.id)).rejects.toThrow(
      ProjectDeprovisioningError,
    );
    // Aborted: the project still exists and the delete can be retried.
    await expect(
      core.projects.get(identity, project.id),
    ).resolves.toMatchObject({ id: project.id });

    await core.projects.delete(identity, project.id);
    expect(deprovisioned).toContain(project.id);
    await expect(core.projects.get(identity, project.id)).rejects.toThrow(
      ProjectNotFoundError,
    );
  });
});
