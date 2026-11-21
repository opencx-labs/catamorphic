import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import {
  FsBackend,
  FsRemoteBackend,
  nativeGit,
  ProjectManager,
} from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectsService } from "../services/projects-service.js";
import { RemoteSyncService } from "../services/remote-sync-service.js";
import { fakeCodeHost, gitHttpServer } from "./code-host-fixture.js";

const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const identity = { tenantId: crypto.randomUUID(), externalUserId: "server" };
const projectId = crypto.randomUUID();
const author = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

describe("published sync of an attached project (ADR 0170)", () => {
  let temp: string;
  let origin: string;
  let codeHost: string;
  let server: Awaited<ReturnType<typeof gitHttpServer>>;
  let sync: RemoteSyncService;
  let projects: ProjectsService;
  /** What the sync told following enablements about (ADR 0330). */
  const published: Array<{ projectId: string; commitSha: string }> = [];

  /** Commit a file on top of `branch` of a bare repository. */
  async function commitTo(repo: string, file: string, from = repo) {
    const work = await fs.mkdtemp(path.join(temp, "work-"));
    await nativeGit(temp, ["clone", "-q", from, work]);
    await fs.writeFile(path.join(work, file), file);
    await nativeGit(work, ["add", "."]);
    await nativeGit(work, [...author, "commit", "-qm", file]);
    await nativeGit(work, ["push", "-q", repo, "HEAD:main"]);
  }

  const divergedAt = async () =>
    (await projects.get(identity, projectId)).remoteDivergedAt;

  beforeAll(async () => {
    await migrateToLatest({ db });
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "published-sync-"));
    const manager = new ProjectManager(
      new FsBackend(path.join(temp, "dev")),
      new FsRemoteBackend(path.join(temp, "origin")),
    );
    await db
      .insertInto("tenants")
      .values({ id: identity.tenantId, name: "test" })
      .execute();
    await manager.create(identity.tenantId, projectId, {
      name: "Company",
      externalUserId: identity.externalUserId,
    });
    origin = path.join(temp, "origin", identity.tenantId, `${projectId}.git`);
    // The company's repository on its code host, as the project was imported.
    const hosted = path.join(temp, "hosted");
    await fs.mkdir(hosted);
    codeHost = path.join(hosted, "company.git");
    await nativeGit(temp, ["clone", "-q", "--bare", origin, codeHost]);
    server = await gitHttpServer(hosted);
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        tenant_id: identity.tenantId,
        name: "Company",
        remote_url: `${server.url}/company.git`,
        remote_ownership: "attached",
        remote_branch: "main",
        default_branch: "main",
      })
      .execute();
    projects = new ProjectsService(db, manager);
    const forge = fakeCodeHost({
      db,
      projectManager: manager,
      remoteBase: server.url,
    });
    sync = new RemoteSyncService(
      db,
      manager,
      forge.codeHosts,
      async (input) => {
        published.push(input);
      },
    );
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await db.destroy();
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  });

  it("publishes what it receives, so following enablements move", async () => {
    await commitTo(codeHost, "agents.md");
    const pulled = await sync.syncPublished({ identity, projectId });
    expect(pulled.status).toBe("pulled");
    expect(published).toEqual([
      {
        projectId,
        commitSha: pulled.status === "pulled" ? pulled.remoteSha : "",
      },
    ]);
    expect((await sync.syncPublished({ identity, projectId })).status).toBe(
      "up-to-date",
    );
    expect(published).toHaveLength(1);
    published.length = 0;
  }, 60_000);

  it("records since when main diverged, and clears it once they converge", async () => {
    await commitTo(codeHost, "roles.json");
    expect((await sync.syncPublished({ identity, projectId })).status).toBe(
      "pulled",
    );
    expect(await divergedAt()).toBeNull();

    // A direct deploy on the server, then a merge on the code host.
    await commitTo(origin, "deployed.md");
    await commitTo(codeHost, "merged.md");
    expect((await sync.syncPublished({ identity, projectId })).status).toBe(
      "diverged",
    );
    const since = await divergedAt();
    expect(since).not.toBeNull();
    // Still diverged: the first moment is kept.
    await sync.syncPublished({ identity, projectId });
    expect(await divergedAt()).toBe(since);

    // Someone reconciles: the code host merges the server's commit.
    const work = await fs.mkdtemp(path.join(temp, "reconcile-"));
    await nativeGit(temp, ["clone", "-q", codeHost, work]);
    await nativeGit(work, [...author, "pull", "-q", "--no-rebase", origin]);
    await nativeGit(work, ["push", "-q", codeHost, "HEAD:main"]);
    expect((await sync.syncPublished({ identity, projectId })).status).toBe(
      "pulled",
    );
    expect(await divergedAt()).toBeNull();
  }, 60_000);
});
