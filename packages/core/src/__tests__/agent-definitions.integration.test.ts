import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { ProjectNotFoundError } from "../services/projects-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_agentdefs_${crypto.randomUUID().replaceAll("-", "")}`;

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "alice",
};

describeIf("AgentDefinitionsService (ADR 0050)", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;
  let core: CatamorphicCore;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-agents-"));
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
    core = new CatamorphicCore({ db, projectManager });

    const project = await core.projects.create(identity, {
      name: "with-agents",
    });
    projectId = project.id;

    // Author the agents/ directory the way a collaborator would: committed
    // files in the project repo (one valid + persona, one valid without a
    // persona, one broken).
    const repo = await projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      await repo.writeFile(
        "agents/triage.json",
        JSON.stringify({
          version: 1,
          name: "Support Triage",
          kind: "claude-code",
          description: "Triages support threads",
          credentials: { source: "profile" },
        }),
      );
      await repo.writeFile("agents/triage.md", "# Persona\nBe terse.\n");
      await repo.writeFile(
        "agents/reviewer.json",
        JSON.stringify({ version: 1, name: "Reviewer", kind: "codex" }),
      );
      await repo.writeFile("agents/broken.json", "{ not json");
      await repo.commit("Add project agents", {
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

  it("lists parsed definitions with personas, reporting broken files instead of throwing", async () => {
    const entries = await core.agentDefinitions.list(identity, projectId);
    expect(entries.map((entry) => entry.slug)).toEqual([
      "broken",
      "reviewer",
      "triage",
    ]);

    const triage = entries.find((entry) => entry.slug === "triage");
    expect(triage?.definition).toMatchObject({
      name: "Support Triage",
      kind: "claude-code",
      credentials: { source: "profile" },
    });
    expect(triage?.promptFile).toContain("Be terse.");
    expect(triage?.invalid).toBeUndefined();

    const reviewer = entries.find((entry) => entry.slug === "reviewer");
    expect(reviewer?.definition?.kind).toBe("codex");
    expect(reviewer?.promptFile).toBeUndefined();

    const broken = entries.find((entry) => entry.slug === "broken");
    expect(broken?.definition).toBeUndefined();
    expect(broken?.invalid?.error).toMatch(/JSON/);
  });

  it("returns an empty list for a project without an agents/ directory", async () => {
    const bare = await core.projects.create(identity, { name: "bare" });
    await expect(
      core.agentDefinitions.list(identity, bare.id),
    ).resolves.toEqual([]);
  });

  it("scopes reads to the caller's tenant", async () => {
    const stranger: Identity = {
      tenantId: crypto.randomUUID(),
      externalUserId: "mallory",
    };
    await expect(
      core.agentDefinitions.list(stranger, projectId),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
