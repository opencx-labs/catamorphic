import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { FsBackend, nativeGit, ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteSyncService } from "../services/remote-sync-service.js";
import { fakeCodeHost } from "./code-host-fixture.js";

/**
 * ADR 0170 through the core service: whatever sync and pull-request calls
 * run against an attached repository, its default branch and every branch
 * Work did not create stay exactly as the people sharing it left them.
 */
const database = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite: database }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const identity = { tenantId: crypto.randomUUID(), externalUserId: "test" };
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
let temp: string;

beforeAll(async () => {
  await migrateToLatest({ db });
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "remote-ownership-"));
  await db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "test" })
    .execute();
}, 30_000);

afterAll(async () => {
  await db.destroy();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

async function linkedProject(ownership: "owned" | "attached") {
  const projectId = crypto.randomUUID();
  const base = path.join(temp, projectId);
  const origin = path.join(base, "origin.git");
  const seed = path.join(base, "seed");
  const root = path.join(base, "root");
  await fs.mkdir(origin, { recursive: true });
  await fs.mkdir(seed);
  await nativeGit(origin, ["init", "--bare", "-b", "trunk"]);
  await nativeGit(seed, ["init", "-b", "trunk"]);
  await fs.writeFile(path.join(seed, "notes.md"), "shared");
  await nativeGit(seed, ["add", "."]);
  await nativeGit(seed, [...author, "commit", "-m", "shared"]);
  await nativeGit(seed, ["push", origin, "trunk", "trunk:refs/heads/release"]);
  await nativeGit(base, ["clone", origin, root]);
  await db
    .insertInto("projects")
    .values({
      id: projectId,
      tenant_id: identity.tenantId,
      name: ownership,
      remote_url: origin,
      remote_ownership: ownership,
      remote_branch: "trunk",
      default_branch: "trunk",
    })
    .execute();
  const manager = new ProjectManager(
    new FsBackend(path.join(base, "internal"), async () => root),
    undefined,
    async () => root,
  );
  const forge = fakeCodeHost({ db, projectManager: manager, remoteBase: base });
  await forge.connectPersonal(identity, `token-${ownership}`);
  const service = new RemoteSyncService(db, manager, forge.codeHosts);
  const createPullRequest = forge.createPullRequest;
  const commit = async (dir: string, file: string) => {
    await fs.writeFile(path.join(dir, file), file);
    await nativeGit(dir, ["add", "."]);
    await nativeGit(dir, [...author, "commit", "-m", file]);
    return (await nativeGit(dir, ["rev-parse", "HEAD"])).trim();
  };
  const refs = async () =>
    Object.fromEntries(
      (
        await nativeGit(origin, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ])
      )
        .trim()
        .split("\n")
        .map((line) => line.split(" ")),
    );
  return {
    projectId,
    origin,
    seed,
    root,
    service,
    createPullRequest,
    commit,
    refs,
  };
}

describe("remote sync by ownership (ADR 0170)", () => {
  it("never moves an attached repository's branches, and shares local work as a work/ pull request", async () => {
    const project = await linkedProject("attached");
    const shared = await project.refs();

    const local = await project.commit(project.root, "local.md");
    expect(
      await project.service.sync(identity, project.projectId),
    ).toMatchObject({ status: "ahead", localSha: local });
    expect(await project.refs()).toEqual(shared);

    await project.commit(project.seed, "theirs.md");
    await nativeGit(project.seed, ["push", project.origin, "trunk"]);
    const moved = await project.refs();
    const diverged = await project.service.sync(identity, project.projectId);
    expect(diverged.status).toBe("diverged");
    expect(diverged).not.toHaveProperty("rescueBranch");
    expect(await project.refs()).toEqual(moved);

    const pr = await project.service.createPullRequest(
      identity,
      project.projectId,
      { title: "Local notes" },
    );
    expect(pr.branch).toMatch(/^work\/local-notes-/);
    expect(project.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "trunk", head: pr.branch }),
    );
    const after = await project.refs();
    expect(after[`refs/heads/${pr.branch}`]).toBe(local);
    // Only Work's own branch was added; trunk and release are untouched.
    expect(
      Object.keys(after).filter(
        (ref) => !(ref in moved) && !ref.startsWith("refs/heads/work/"),
      ),
    ).toEqual([]);
    for (const [ref, sha] of Object.entries(moved))
      expect(after[ref]).toBe(sha);
  });

  it("fast-forwards an attached checkout that is strictly behind", async () => {
    const project = await linkedProject("attached");
    const theirs = await project.commit(project.seed, "theirs.md");
    await nativeGit(project.seed, ["push", project.origin, "trunk"]);
    expect(
      await project.service.sync(identity, project.projectId),
    ).toMatchObject({ status: "pulled", localSha: theirs });
    expect((await nativeGit(project.root, ["rev-parse", "HEAD"])).trim()).toBe(
      theirs,
    );
  });

  it("keeps ADR 0044 behavior for an owned repository: local commits are pushed", async () => {
    const project = await linkedProject("owned");
    const local = await project.commit(project.root, "local.md");
    expect(
      await project.service.sync(identity, project.projectId),
    ).toMatchObject({ status: "pushed", localSha: local });
    expect((await project.refs())["refs/heads/trunk"]).toBe(local);
  });
});
