import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { FsBackend, nativeGit, ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { CodeHostNotConnectedError } from "../services/code-hosts-service.js";
import { RemoteSyncService } from "../services/remote-sync-service.js";
import { fakeCodeHost } from "./code-host-fixture.js";

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
      remote_ownership: "attached",
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
  const forge = fakeCodeHost({ db, projectManager: manager, remoteBase: temp });
  await forge.connectPersonal(identity, "member-token");
  const service = new RemoteSyncService(db, manager, forge.codeHosts);
  const result = await service.createPullRequestFromRef(identity, projectId, {
    title: "Worktree review",
    localRef: "feature",
  });
  // The caller's own connection pushed the branch and opened the PR.
  expect(forge.createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({ base: "trunk", head: result.branch }),
  );
  expect(result.url).toBe("https://forge.test/pr/member-token");
  expect(forge.gitCalls).toContainEqual({
    token: "member-token",
    access: "write",
    remoteUrl: remote,
  });
  expect(await nativeGit(remote, ["show", `${result.branch}:notes.txt`])).toBe(
    "feature",
  );
  expect(await nativeGit(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(index);
  await expect(
    service.createPullRequest(identity, projectId, { title: "Private work" }),
  ).rejects.toThrow("will not stage");
});
it("propagates listing failures while unsupported or unconnected hosts remain an empty list", async () => {
  const forge = fakeCodeHost({ db, projectManager: manager, remoteBase: temp });
  const other = { ...identity, externalUserId: "other" };
  expect(
    await forge.codeHosts.listPullRequests({ identity: other, projectId }),
  ).toEqual([]);
  await forge.connectPersonal(other, "other-token");
  vi.mocked(forge.host.listPullRequests)?.mockRejectedValueOnce(
    new Error("Sign in again"),
  );
  await expect(
    forge.codeHosts.listPullRequests({ identity: other, projectId }),
  ).rejects.toThrow("Sign in again");
  const unrelated = fakeCodeHost({
    db,
    projectManager: manager,
    remoteBase: "https://elsewhere.test/",
  });
  expect(
    await unrelated.codeHosts.listPullRequests({ identity, projectId }),
  ).toEqual([]);
});
// Last: it leaves an organization connection behind.
it("opens pull requests only for writers and lets readers comment only as themselves", async () => {
  const forge = fakeCodeHost({ db, projectManager: manager, remoteBase: temp });
  const admin: Identity = {
    ...identity,
    externalUserId: "admin",
    controlPlanePermissions: ["connections:read", "connections:write"],
  };
  await forge.connectService(admin, "org-token");
  const reader: Identity = {
    ...identity,
    externalUserId: "reader",
    scope: [],
    projectPermissions: [{ projectId, permission: "program:read" }],
  };
  const service = new RemoteSyncService(db, manager, forge.codeHosts);
  // The organization's connection would push and open it: the caller's own
  // permission decides.
  await expect(
    service.createPullRequest(reader, projectId, { title: "Reader work" }),
  ).rejects.toBeInstanceOf(AccessDeniedError);
  expect(forge.gitCalls).toEqual([]);
  expect(forge.createPullRequest).not.toHaveBeenCalled();
  const comment = (who: Identity, principal?: "service") =>
    forge.codeHosts.commentOnPullRequest({
      identity: who,
      projectId,
      number: 1,
      body: "Looks good",
      ...(principal ? { principal } : {}),
    });
  // A reader never speaks as the organization.
  await expect(comment(reader)).rejects.toBeInstanceOf(
    CodeHostNotConnectedError,
  );
  await expect(comment(reader, "service")).rejects.toBeInstanceOf(
    AccessDeniedError,
  );
  await forge.connectPersonal(reader, "reader-token");
  expect((await comment(reader)).author).toEqual({ login: "reader-token" });
  // A writer may comment through the organization's connection.
  const writer: Identity = {
    ...reader,
    externalUserId: "writer",
    projectPermissions: [{ projectId, permission: "program:write" }],
  };
  expect((await comment(writer)).author).toEqual({ login: "org-token" });
});
