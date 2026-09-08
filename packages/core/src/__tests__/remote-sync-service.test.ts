import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { FsBackend, nativeGit, ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { RemoteSyncService } from "../services/remote-sync-service.js";

const database = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite: database }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const identity = { tenantId: crypto.randomUUID(), externalUserId: "test" };
const projectId = crypto.randomUUID();
let temp: string;
let root: string;
let remote: string;
let manager: ProjectManager;
const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
beforeAll(async () => {
  await migrateToLatest({ db });
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "remote-review-"));
  root = path.join(temp, "root");
  remote = path.join(temp, "origin");
  await fs.mkdir(root);
  await fs.mkdir(remote);
  await nativeGit(remote, ["init", "--bare", "-b", "trunk"]);
  await nativeGit(root, ["init", "-b", "trunk"]);
  await fs.writeFile(path.join(root, "notes.txt"), "initial");
  await nativeGit(root, ["add", "."]);
  await nativeGit(root, [...author, "commit", "-m", "initial"]);
  await nativeGit(root, ["push", remote, "trunk"]);
  await db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "test" })
    .execute();
  await db
    .insertInto("projects")
    .values({
      id: projectId,
      tenant_id: identity.tenantId,
      name: "test",
      remote_url: remote,
      remote_branch: "feature",
      default_branch: "trunk",
    })
    .execute();
  manager = new ProjectManager(
    new FsBackend(path.join(temp, "internal"), async () => root),
    undefined,
    async () => root,
  );
}, 30_000);
afterAll(async () => {
  await db.destroy();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});
it("pushes the selected worktree branch for review against the default branch without consuming primary changes", async () => {
  const linked = path.join(temp, "linked");
  await nativeGit(root, ["worktree", "add", "-b", "feature", linked]);
  await fs.writeFile(path.join(linked, "notes.txt"), "feature");
  await nativeGit(linked, ["add", "."]);
  await nativeGit(linked, [...author, "commit", "-m", "feature"]);
  await fs.writeFile(path.join(root, "notes.txt"), "private staged");
  await nativeGit(root, ["add", "."]);
  const index = await fs.readFile(path.join(root, ".git/index"));
  const head = await nativeGit(root, ["rev-parse", "HEAD"]);
  const createPullRequest = vi.fn(async () => ({
    url: "https://example.invalid/pr/1",
    number: 1,
  }));
  const service = new RemoteSyncService(db, manager, [
    {
      id: "test",
      handles: () => true,
      credentials: async () => undefined,
      createPullRequest,
    },
  ]);
  const result = await service.createPullRequestFromRef(identity, projectId, {
    title: "Worktree review",
    localRef: "feature",
  });
  expect(createPullRequest).toHaveBeenCalledWith(
    identity,
    expect.objectContaining({ base: "trunk", head: result.branch }),
  );
  expect(await nativeGit(remote, ["show", `${result.branch}:notes.txt`])).toBe(
    "feature",
  );
  expect(await nativeGit(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(index);
  await expect(
    service.createPullRequest(identity, projectId, { title: "Private work" }),
  ).rejects.toThrow("will not stage");
});
it("propagates listing failures while unsupported hosts remain an empty list", async () => {
  const service = new RemoteSyncService(db, manager, [
    {
      id: "test",
      handles: () => true,
      credentials: async () => undefined,
      listPullRequests: async () => {
        throw new Error("Sign in again");
      },
    },
  ]);
  await expect(service.listPullRequests(identity, projectId)).rejects.toThrow(
    "Sign in again",
  );
  expect(
    await new RemoteSyncService(db, manager, []).listPullRequests(
      identity,
      projectId,
    ),
  ).toEqual([]);
});
