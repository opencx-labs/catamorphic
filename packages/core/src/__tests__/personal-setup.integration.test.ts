import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import {
  PersonalEnvironmentInvalidError,
  PersonalEnvironmentService,
  personalFingerprint,
} from "../services/personal-environment-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";

/**
 * A member's own setup command (ADR 0207): kept with their personal
 * environment, shown back only to them, replaced and removed with their
 * set, and audited by fingerprint.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_personal_setup_${randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 2 })
  : undefined;

const tenantId = randomUUID();
const ada: Identity = { tenantId, externalUserId: "ada" };
const bob: Identity = { tenantId, externalUserId: "bob" };

describeIf("personal setup (ADR 0207)", () => {
  let tmpDir: string;
  let projectId: string;
  let service: PersonalEnvironmentService;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-setup-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projectId = (
      await new ProjectsService(db, projectManager).create(ada, {
        name: "setup",
      })
    ).id;
    service = new PersonalEnvironmentService({
      db,
      vault: new MemoryCredentialVault(),
      environments: new ProjectEnvironmentsService(db, projectManager),
    });
  });

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const audits = async () =>
    db!
      .selectFrom("connection_audit_events")
      .select(["event_type", "metadata"])
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at")
      .execute();

  it("keeps the command with the member's set and shows it only to them", async () => {
    const status = await service.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: "mise install" },
    });
    expect(status.setup).toMatchObject({ command: "mise install" });
    expect(await service.setup({ tenantId, projectId, owner: "ada" })).toBe(
      "mise install",
    );
    expect((await service.status({ identity: bob, projectId })).setup).toBe(
      null,
    );
    expect(await service.setup({ tenantId, projectId, owner: "bob" })).toBe(
      undefined,
    );
    expect((await audits()).at(-1)).toMatchObject({
      event_type: "personal_environment.replace",
      metadata: {
        changed: [
          {
            kind: "setup",
            name: "setup",
            fingerprint: personalFingerprint("mise install"),
          },
        ],
      },
    });
  });

  it("replaces it, leaves an unchanged one alone, and drops it when absent or blank", async () => {
    const count = (await audits()).length;
    await service.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: "mise install" },
    });
    expect(await audits()).toHaveLength(count);
    await service.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: "mise install && direnv allow" },
    });
    expect(await service.setup({ tenantId, projectId, owner: "ada" })).toBe(
      "mise install && direnv allow",
    );
    const blank = await service.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: "  " },
    });
    expect(blank.setup).toBeNull();
    expect((await audits()).at(-1)?.metadata).toMatchObject({
      removed: [{ kind: "setup", name: "setup" }],
    });
    await service.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: "make tools" },
    });
    await service.replace({ identity: ada, projectId, input: { files: [] } });
    expect(
      await service.setup({ tenantId, projectId, owner: "ada" }),
    ).toBeUndefined();
  });

  it("refuses a command that is too long, and forgets it with the rest", async () => {
    await expect(
      service.replace({
        identity: ada,
        projectId,
        input: { files: [], setup: "x".repeat(16_385) },
      }),
    ).rejects.toBeInstanceOf(PersonalEnvironmentInvalidError);
    await service.replace({
      identity: ada,
      projectId,
      input: { files: [], setup: "make tools" },
    });
    await service.remove({ identity: ada, projectId });
    expect(
      await service.setup({ tenantId, projectId, owner: "ada" }),
    ).toBeUndefined();
    expect((await audits()).at(-1)).toMatchObject({
      event_type: "personal_environment.remove",
      metadata: { removed: [{ kind: "setup", name: "setup" }] },
    });
  });
});
