import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { testEnvironmentProvider } from "./test-environment.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_skills_${crypto.randomUUID().replaceAll("-", "")}`;

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "alice",
};

/** The user tier's backing map (ADR 0056) — mutated by tests, read live. */
const userSkillFiles: Record<string, string> = {};

const HOST_SKILLS = {
  "publishing-to-github/SKILL.md": [
    "---",
    "name: publishing-to-github",
    "description: Push the project to GitHub.",
    "---",
    "",
    "# Host github skill body",
  ].join("\n"),
  "shadowed/SKILL.md": [
    "---",
    "name: shadowed",
    "description: The HOST version.",
    "---",
    "",
    "host body",
  ].join("\n"),
};

describeIf("SkillsService host tier (ADR 0049)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-skills-"));
    const devDir = path.join(tmpDir, "dev");
    const originDir = path.join(tmpDir, "origin");
    await fs.mkdir(devDir, { recursive: true });
    await fs.mkdir(originDir, { recursive: true });
    const projectManager = new ProjectManager(
      new FsBackend(devDir),
      new FsRemoteBackend(originDir),
    );
    db = createDatabase({ connectionString, schema, poolSize: 4 });
    await migrateToLatest({ db, schema });
    core = new CatamorphicCore({
      db,
      projectManager,
      environmentProvider: testEnvironmentProvider(),
      // No seed skills: the project tier holds exactly what this test
      // writes, so assertions stay independent of the framework seeds.
      projectSeeds: () => ({}),
      hostSkills: () => ({ ...HOST_SKILLS }),
      // The user tier (ADR 0056) is a live getter — tests mutate the map.
      userSkills: () => ({ ...userSkillFiles }),
    });

    const project = await core.projects.create(identity, {
      name: "with-skills",
    });
    projectId = project.id;

    const repo = await projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      await repo.writeFile(
        ".agents/skills/local-notes/SKILL.md",
        "---\nname: local-notes\ndescription: A project skill.\n---\n\nproject body",
      );
      await repo.writeFile(
        ".agents/skills/shadowed/SKILL.md",
        "---\nname: shadowed\ndescription: The PROJECT version.\n---\n\nproject shadow body",
      );
      await repo.commit("Add project skills", {
        name: "alice",
        email: "alice@example.com",
      });
    } finally {
      await repo.dispose();
    }
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("merges both tiers, project shadowing host on name collisions", async () => {
    const skills = await core.skills.list(identity, projectId);
    expect(skills.map((skill) => `${skill.name}:${skill.source}`)).toEqual([
      "local-notes:project",
      "publishing-to-github:host",
      "shadowed:project",
    ]);
    const shadowed = skills.find((skill) => skill.name === "shadowed");
    expect(shadowed?.description).toBe("The PROJECT version.");
  });

  it("reads content by name from either tier, project winning", async () => {
    const host = await core.skills.read(
      identity,
      projectId,
      "publishing-to-github",
    );
    expect(host?.skill.source).toBe("host");
    expect(host?.content).toContain("Host github skill body");

    const shadowed = await core.skills.read(identity, projectId, "shadowed");
    expect(shadowed?.skill.source).toBe("project");
    expect(shadowed?.content).toContain("project shadow body");

    expect(await core.skills.read(identity, projectId, "missing")).toBeNull();
  });

  it("user tier (ADR 0056): live-read, between project and host, absent from shared", async () => {
    userSkillFiles["expenses/SKILL.md"] =
      "---\nname: expenses\ndescription: Personal expense filing.\n---\n\nuser body";
    // A personal skill shadowing a host name wins; a project name wins
    // over the personal one.
    userSkillFiles["publishing-to-github/SKILL.md"] =
      "---\nname: publishing-to-github\ndescription: My USER variant.\n---\n\nuser github body";
    userSkillFiles["shadowed/SKILL.md"] =
      "---\nname: shadowed\ndescription: The USER version.\n---\n\nuser shadow body";
    try {
      const skills = await core.skills.list(identity, projectId);
      expect(skills.map((skill) => `${skill.name}:${skill.source}`)).toEqual([
        "expenses:user",
        "local-notes:project",
        "publishing-to-github:user",
        "shadowed:project",
      ]);

      const user = await core.skills.read(identity, projectId, "expenses");
      expect(user?.skill.source).toBe("user");
      expect(user?.content).toContain("user body");
      const github = await core.skills.read(
        identity,
        projectId,
        "publishing-to-github",
      );
      expect(github?.skill.source).toBe("user");

      // The shared surface (project MCP, ADR 0055) never lists or reads
      // the user tier — personal by definition.
      const shared = await core.skills.listShared(identity, projectId);
      expect(shared.some((skill) => (skill.source as string) === "user")).toBe(
        false,
      );
      const sharedRead = await core.skills.readShared(
        identity,
        projectId,
        "expenses",
      );
      expect(sharedRead).toBeNull();
    } finally {
      for (const key of Object.keys(userSkillFiles)) {
        delete userSkillFiles[key];
      }
    }
  });
});
