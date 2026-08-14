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
} from "../templates.js";

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
 * the designing-apps doctrine with its own, removes the batch/durable
 * workflow skills, and ships one custom template. Projects created under
 * this core must carry EXACTLY the embedder's seed set on disk.
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
      projectTemplates: (defaults) => [
        {
          id: "acme-crm",
          name: "Acme CRM",
          description: "Acme's starter",
          defaultWorkflow: "syncContacts",
          files: {
            "workflows/src/crm.ts": "export {};\n",
            // Collides with a seed path: the template must win.
            [MECHANICS_SKILL_PATH]: "# Acme CRM build notes\n",
          },
        },
        ...defaults.filter((template) => template.id === "welcome-user"),
      ],
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

  it("template projects compose the embedder's seeds under the template, template winning collisions", async () => {
    const project = await core.projects.create(identity, {
      name: "CRM under Acme",
      templateId: "acme-crm",
    });
    const files = await core.projects.readAllFiles(identity, project.id);

    expect(files["workflows/src/crm.ts"]).toBe("export {};\n");
    expect(files[MECHANICS_SKILL_PATH]).toBe("# Acme CRM build notes\n");
    expect(files[ACME_DESIGN_SKILL_PATH]).toBe(ACME_DESIGN_SKILL);
    expect(files[DESIGN_SKILL_PATH]).toBeUndefined();
    expect(files[BATCH_WORKFLOW_SKILL_PATH]).toBeUndefined();
    expect(files[DURABLE_WORKFLOW_SKILL_PATH]).toBeUndefined();
  });

  it("removed framework templates are not creatable; kept ones are", async () => {
    await expect(
      core.projects.create(identity, {
        name: "No dashboard",
        templateId: "orders-dashboard",
      }),
    ).rejects.toThrow("Template 'orders-dashboard' not found");

    const project = await core.projects.create(identity, {
      name: "Welcome under Acme",
      templateId: "welcome-user",
    });
    const files = await core.projects.readAllFiles(identity, project.id);
    expect(files["workflows/src/welcome.ts"]).toContain("welcomeUser");
    // The kept framework template also picks up the embedder's seed set.
    expect(files[ACME_DESIGN_SKILL_PATH]).toBe(ACME_DESIGN_SKILL);
    expect(files[BATCH_WORKFLOW_SKILL_PATH]).toBeUndefined();
  });
});
