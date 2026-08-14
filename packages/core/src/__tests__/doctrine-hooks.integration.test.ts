import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import {
  BATCH_WORKFLOW_SKILL_PATH,
  DURABLE_WORKFLOW_SKILL_PATH,
  SEED_SKILLS,
} from "../seeds.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_doctrine_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "doctrine-test-user",
};

const MECHANICS_SKILL_PATH = ".agents/skills/building-apps/SKILL.md";
const DESIGN_SKILL_PATH = ".agents/skills/designing-apps/SKILL.md";
const ACME_DESIGN_SKILL_PATH = ".agents/skills/acme-design/SKILL.md";
const ACME_DESIGN_SKILL = `---
name: acme-design
description: Acme's app design doctrine.
---

# Acme design

Serif everything. One accent color: Acme red.
`;

let tempDirectory = "";
let core: CatamorphicCore;

/**
 * An alien embedder (ADR 0049): keeps the framework's mechanics, replaces
 * the designing-apps doctrine with its own, and removes the batch/durable
 * workflow skills. Projects created under this core must carry EXACTLY the
 * embedder's seed set on disk.
 */
describeIf("doctrine hooks integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-doctrine-"),
    );
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tempDirectory, "dev")),
      new FsRemoteBackend(path.join(tempDirectory, "remote")),
    );
    core = new CatamorphicCore({
      db,
      projectManager,
      projectSeeds: (defaults) => {
        const seeds = { ...defaults };
        delete seeds[DESIGN_SKILL_PATH];
        delete seeds[BATCH_WORKFLOW_SKILL_PATH];
        delete seeds[DURABLE_WORKFLOW_SKILL_PATH];
        seeds[ACME_DESIGN_SKILL_PATH] = ACME_DESIGN_SKILL;
        return seeds;
      },
    });
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await db.destroy();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("blank projects carry exactly the embedder's seed set", async () => {
    const project = await core.projects.create(identity, {
      name: "Blank under Acme",
    });
    const files = await core.projects.readAllFiles(identity, project.id);
    const skillPaths = Object.keys(files)
      .filter((file) => file.startsWith(".agents/"))
      .sort();

    // Custom doctrine present, ours absent, mechanics present.
    expect(files[ACME_DESIGN_SKILL_PATH]).toBe(ACME_DESIGN_SKILL);
    expect(files[DESIGN_SKILL_PATH]).toBeUndefined();
    expect(files[BATCH_WORKFLOW_SKILL_PATH]).toBeUndefined();
    expect(files[DURABLE_WORKFLOW_SKILL_PATH]).toBeUndefined();
    expect(files[MECHANICS_SKILL_PATH]).toBe(SEED_SKILLS[MECHANICS_SKILL_PATH]);
    expect(skillPaths).toEqual(Object.keys(core.seedFiles).sort());
  });
});
