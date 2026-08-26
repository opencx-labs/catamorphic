import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import {
  FsBackend,
  PROJECT_MANIFEST_PATH,
  ProjectManager,
} from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});

describe("project Environment policy persistence", () => {
  let projectsPath: string;

  beforeAll(async () => {
    projectsPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-environments-"),
    );
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await fs.rm(projectsPath, { recursive: true, force: true });
  });

  it("defaults a project without a manifest to local", async () => {
    const identity: Identity = {
      tenantId: crypto.randomUUID(),
      externalUserId: "root",
    };
    const projectManager = new ProjectManager(new FsBackend(projectsPath));
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    const project = await projects.create(identity, { name: "Imported" });
    const repo = await projectManager.open(identity.tenantId, project.id);
    await repo.deleteFile(PROJECT_MANIFEST_PATH);
    await repo.commit("Remove manifest", {
      name: "Test",
      email: "test@catamorphic.dev",
    });
    await repo.dispose();

    const policy = await new ProjectEnvironmentsService(
      db,
      projectManager,
    ).list({ identity, projectId: project.id });

    expect(policy).toMatchObject({
      defaultEnvironment: "local",
      environments: {
        local: {
          binding: "local",
          workloads: ["agent", "workflow"],
        },
      },
    });
    expect(policy.invalid).toBeUndefined();
  });
});
