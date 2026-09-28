import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { PersonalLoginKind } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import {
  PersonalEnvironmentInvalidError,
  PersonalEnvironmentService,
  PersonalEnvironmentUnavailableError,
} from "../services/personal-environment-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";

/**
 * A member's personal environment on a fresh database (ADR 0184): sealed
 * in the vault, readable and replaceable only by that member, audited by
 * name and fingerprint, flagged for refresh while in use.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_personal_env_${crypto.randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const tenantId = crypto.randomUUID();
const ada: Identity = { tenantId, externalUserId: "ada" };
const bob: Identity = { tenantId, externalUserId: "bob" };
const TOKEN = `sk-ant-oat01-${crypto.randomUUID()}`;
const SECRET = `API_TOKEN=${crypto.randomUUID()}\n`;

const base64 = (text: string) => Buffer.from(text).toString("base64");
const claude = (expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt } });

describeIf("personal environments (ADR 0184)", () => {
  let tmpDir: string;
  let projectId: string;
  let otherProjectId: string;
  let vault: MemoryCredentialVault;
  let service: PersonalEnvironmentService;
  const inUse = new Set<PersonalLoginKind>();

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-personal-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    projectId = (await projects.create(ada, { name: "personal" })).id;
    otherProjectId = (await projects.create(ada, { name: "plain" })).id;
    const repo = await projectManager.open(tenantId, projectId);
    try {
      await repo.writeFile(
        ".work/project.json",
        JSON.stringify({
          environments: {
            dev: { workloads: ["agent"], personalCredentials: true },
          },
        }),
      );
      await repo.commit("Allow personal credentials", {
        name: "ada",
        email: "ada@example.test",
      });
    } finally {
      await repo.dispose();
    }
    vault = new MemoryCredentialVault();
    service = new PersonalEnvironmentService({
      db,
      vault,
      environments: new ProjectEnvironmentsService(db, projectManager),
      loginsInUse: async () => inUse,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("seals what a member sends and returns only fingerprints", async () => {
    const status = await service.replace({
      identity: ada,
      projectId,
      input: {
        logins: {
          "claude-code": { credentials: claude(Date.now() + 8 * 3_600_000) },
        },
        files: [
          { path: ".env", content: base64(SECRET) },
          { path: "apps/api/.env.local", content: base64("LOCAL=1\n") },
        ],
      },
    });
    expect(status.allowed).toBe(true);
    expect(status.logins["claude-code"]?.needsRefresh).toBe(false);
    expect(status.files.map((file) => [file.path, file.bytes])).toEqual([
      [".env", SECRET.length],
      ["apps/api/.env.local", 8],
    ]);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const rows = await db!
      .selectFrom("personal_environment_entries")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain(SECRET.trim());
    // The host alone unseals, for delivery.
    const unsealed = await service.unseal({
      tenantId,
      projectId,
      owner: "ada",
      logins: ["claude-code"],
    });
    expect(unsealed.logins.get("claude-code")?.content).toContain(TOKEN);
    expect(unsealed.files[0]?.content.toString()).toBe(SECRET);
    // A project without the flag does not allow them.
    expect(
      (await service.status({ identity: ada, projectId: otherProjectId }))
        .allowed,
    ).toBe(false);
  });

  it("keeps each member to their own set", async () => {
    expect(await service.status({ identity: bob, projectId })).toMatchObject({
      logins: {},
      files: [],
    });
    await service.replace({
      identity: bob,
      projectId,
      input: {
        logins: {},
        files: [{ path: ".env", content: base64("B=1\n") }],
      },
    });
    const adas = await service.status({ identity: ada, projectId });
    expect(adas.files).toHaveLength(2);
    expect(
      (
        await service.unseal({ tenantId, projectId, owner: "ada", logins: [] })
      ).files[0]?.content.toString(),
    ).toBe(SECRET);
    await service.remove({ identity: bob, projectId });
    expect((await service.status({ identity: bob, projectId })).files).toEqual(
      [],
    );
    expect(
      (await service.status({ identity: ada, projectId })).files,
    ).toHaveLength(2);
    // Neither the project itself nor a scoped outsider may use the routes.
    await expect(
      service.status({
        identity: { tenantId, externalUserId: PROJECT_PRINCIPAL_ID },
        projectId,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      service.status({
        identity: { tenantId, externalUserId: "eve", scope: [] },
        projectId,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("replaces changed entries, releases replaced vault records, and refuses bad input whole", async () => {
    const before = await db!
      .selectFrom("personal_environment_entries")
      .select(["name", "credential_ref"])
      .where("external_user_id", "=", "ada")
      .execute();
    const status = await service.replace({
      identity: ada,
      projectId,
      input: {
        logins: {
          "claude-code": { credentials: claude(Date.now() + 8 * 3_600_000) },
        },
        files: [{ path: ".env", content: base64(SECRET) }],
      },
    });
    expect(status.files.map((file) => file.path)).toEqual([".env"]);
    const after = await db!
      .selectFrom("personal_environment_entries")
      .select(["name", "credential_ref"])
      .where("external_user_id", "=", "ada")
      .execute();
    // Unchanged content keeps its record; the dropped file's is gone.
    const ref = (rows: typeof before, name: string) =>
      rows.find((row) => row.name === name)?.credential_ref;
    expect(ref(after, ".env")).toBe(ref(before, ".env"));
    const dropped = ref(before, "apps/api/.env.local");
    await expect(
      vault.withMaterial({
        tenantId,
        ref: { id: dropped ?? "" },
        use: () => true,
      }),
    ).rejects.toThrow();

    await expect(
      service.replace({
        identity: ada,
        projectId,
        input: {
          logins: {
            "claude-code": {
              credentials: JSON.stringify({
                claudeAiOauth: { accessToken: TOKEN, refreshToken: "rt" },
              }),
            },
          },
          files: [],
        },
      }),
    ).rejects.toBeInstanceOf(PersonalEnvironmentInvalidError);
    expect(
      (await service.status({ identity: ada, projectId })).files,
    ).toHaveLength(1);
  });

  it("asks for a fresh login only while one that expires soon is in use", async () => {
    await service.replace({
      identity: ada,
      projectId,
      input: {
        logins: {
          "claude-code": { credentials: claude(Date.now() + 10 * 60_000) },
        },
        files: [],
      },
    });
    expect(
      (await service.status({ identity: ada, projectId })).logins["claude-code"]
        ?.needsRefresh,
    ).toBe(false);
    inUse.add("claude-code");
    expect(
      (await service.status({ identity: ada, projectId })).logins["claude-code"]
        ?.needsRefresh,
    ).toBe(true);
    inUse.clear();
  });

  it("audits names and fingerprints, never values", async () => {
    const audits = await db!
      .selectFrom("connection_audit_events")
      .select(["event_type", "metadata", "actor_external_user_id"])
      .where("event_type", "like", "personal_environment.%")
      .execute();
    expect(audits.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "personal_environment.replace",
        "personal_environment.remove",
      ]),
    );
    expect(JSON.stringify(audits)).toContain("sha256:");
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(JSON.stringify(audits)).not.toContain(SECRET.trim());
  });

  it("refuses to hold anything without a vault", async () => {
    const unsealed = new PersonalEnvironmentService({
      db: db!,
      environments: new ProjectEnvironmentsService(
        db!,
        new ProjectManager(new FsBackend(path.join(tmpDir, "projects"))),
      ),
    });
    await expect(
      unsealed.replace({
        identity: ada,
        projectId,
        input: { logins: {}, files: [] },
      }),
    ).rejects.toBeInstanceOf(PersonalEnvironmentUnavailableError);
  });
});
