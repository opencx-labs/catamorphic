import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import {
  CheckoutRemoteBackend,
  FsBackend,
  FsRemoteBackend,
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
  it("uses local working files for the owner and only published policy for scoped identities", async () => {
    const identity: Identity = {
      tenantId: crypto.randomUUID(),
      externalUserId: "root",
    };
    const root = path.join(projectsPath, "plain-policy");
    await fs.mkdir(root);
    const resolver = async () => root;
    const remote = new CheckoutRemoteBackend(
      resolver,
      new FsRemoteBackend(path.join(projectsPath, "unused")),
    );
    const manager = new ProjectManager(
      new FsBackend(projectsPath, resolver),
      remote,
      resolver,
    );
    const projects = new ProjectsService(db, manager, [], { seedFiles: {} });
    const project = await projects.create(identity, {
      name: "Plain policy",
      rootPath: root,
      importExisting: true,
    });
    const repo = await manager.open(identity.tenantId, project.id);
    const service = new ProjectEnvironmentsService(db, manager);
    const scoped: Identity = {
      ...identity,
      scope: [{ kind: "project", projectId: project.id }],
    };
    const manifest = (name: string) =>
      JSON.stringify({
        environments: { [name]: { binding: "local", workloads: ["agent"] } },
        defaultEnvironment: name,
      });
    try {
      await repo.writeFile(PROJECT_MANIFEST_PATH, manifest("draft"));
      expect(
        (await service.list({ identity, projectId: project.id }))
          .defaultEnvironment,
      ).toBe("draft");
      expect(
        (await service.list({ identity: scoped, projectId: project.id }))
          .defaultEnvironment,
      ).toBe("local");
      expect(await fs.readdir(root)).toEqual([".catamorphic"]);
      const sha = await repo.commit("Publish policy", {
        name: "Test",
        email: "test@example.com",
      });
      await remote.withOrigin(identity.tenantId, project.id, (origin) =>
        origin.updateRef({ ref: "refs/heads/main", sha }),
      );
      await repo.writeFile(PROJECT_MANIFEST_PATH, manifest("changed"));
      expect(
        (await service.list({ identity, projectId: project.id }))
          .defaultEnvironment,
      ).toBe("changed");
      expect(
        (await service.list({ identity: scoped, projectId: project.id }))
          .defaultEnvironment,
      ).toBe("draft");
    } finally {
      await repo.dispose();
    }
  });
});
