import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import {
  FsBackend,
  nativeGit,
  ProjectManager,
  RemotePushRefusedError,
} from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { PullRequestSummary } from "../services/code-host.js";
import { CodeHostNotConnectedError } from "../services/code-hosts-service.js";
import {
  PullRequestsService,
  PullRequestUnavailableError,
} from "../services/pull-requests-service.js";
import { fakeCodeHost } from "./code-host-fixture.js";

/**
 * ADR 0345: a pull request is opened from a checkout by pushing its branch
 * as the chat's own `work/` branch, against a real bare repository, with a
 * code host that keeps the pull requests it opened.
 */
const database = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite: database }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "member",
};
const projectId = crypto.randomUUID();
const unlinkedId = crypto.randomUUID();
const SESSION = "0a1b2c3d-4e5f-4789-abcd-ef0123456789";
const author = ["-c", "user.name=Agent", "-c", "user.email=agent@example.test"];
let temp: string;
let checkout: string;
let remote: string;
let other: string;
let forge: ReturnType<typeof fakeCodeHost>;
let service: PullRequestsService;
let pulls: PullRequestSummary[];
let audited: Array<{ outcome: string; metadata: unknown }>;

const git = (cwd: string, args: readonly string[]) =>
  nativeGit(cwd, args).then((output) => output.trim());
const commit = async (cwd: string, file: string, content: string) => {
  await fs.writeFile(path.join(cwd, file), content);
  await git(cwd, ["add", "-A"]);
  await git(cwd, [...author, "commit", "-q", "-m", file]);
  return git(cwd, ["rev-parse", "HEAD"]);
};
const tip = (branch: string) =>
  git(remote, ["rev-parse", `refs/heads/${branch}`]);

beforeAll(async () => {
  await migrateToLatest({ db });
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "work-pulls-"));
  checkout = path.join(temp, "checkout");
  remote = path.join(temp, "origin.git");
  other = path.join(temp, "other");
  await fs.mkdir(remote);
  await fs.mkdir(checkout);
  await git(remote, ["init", "--bare", "-q", "-b", "trunk"]);
  await git(checkout, ["init", "-q", "-b", "trunk"]);
  await commit(checkout, "readme.md", "hello\n");
  await git(checkout, ["push", "-q", remote, "trunk", "trunk:release"]);
  await git(temp, ["clone", "-q", remote, other]);
  await db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "test" })
    .execute();
  await db
    .insertInto("projects")
    .values([
      {
        id: projectId,
        tenant_id: identity.tenantId,
        name: "linked",
        remote_url: remote,
        remote_ownership: "attached",
        remote_branch: "release",
        default_branch: "trunk",
      },
      { id: unlinkedId, tenant_id: identity.tenantId, name: "unlinked" },
    ])
    .execute();
}, 30_000);

beforeEach(() => {
  const manager = new ProjectManager(
    new FsBackend(path.join(temp, "internal")),
  );
  forge = fakeCodeHost({ db, projectManager: manager, remoteBase: temp });
  pulls = [];
  // A code host that keeps what it opened, as a real one does.
  forge.host.createPullRequest = vi.fn(async (input) => {
    const pull: PullRequestSummary = {
      number: pulls.length + 1,
      title: input.title,
      url: `https://forge.test/pull/${pulls.length + 1}`,
      author: "work",
      head: input.head,
      base: input.base,
      draft: false,
      updatedAt: new Date(0).toISOString(),
    };
    pulls.push(pull);
    return { url: pull.url, number: pull.number };
  });
  forge.host.listPullRequests = vi.fn(async () => pulls);
  audited = [];
  service = new PullRequestsService(forge.codeHosts, {
    audit: async (event) => {
      audited.push({ outcome: event.outcome, metadata: event.metadata });
    },
  });
});

afterAll(async () => {
  await db.destroy();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

it("names the pushed branch after the chat unless its branch is already under work/", () => {
  const pullRequests = new PullRequestsService(forge.codeHosts);
  expect(
    pullRequests.remoteBranch({ branch: "work/0a1b2c3d", sessionId: SESSION }),
  ).toBe("work/0a1b2c3d");
  expect(
    pullRequests.remoteBranch({
      branch: "Feature/Fix It!",
      sessionId: SESSION,
    }),
  ).toBe("work/feature-fix-it-0a1b2c3d");
  expect(
    pullRequests.remoteBranch({ branch: "main", sessionId: SESSION }),
  ).toBe("work/main-0a1b2c3d");
  expect(() => pullRequests.remoteBranch({ branch: "main" })).toThrow(
    RemotePushRefusedError,
  );
  expect(pullRequests.remoteBranch({ branch: "work/proposals/a/b" })).toBe(
    "work/proposals/a/b",
  );
});

it("pushes the branch as the chat's own, opens one pull request, updates it, replaces it after a rebase, and refuses to overwrite anyone else", async () => {
  await forge.connectPersonal(identity, "member-token");
  const base = await git(checkout, ["rev-parse", "HEAD"]);
  await git(checkout, ["checkout", "-q", "-b", "feature/x"]);
  const first = await commit(checkout, "one.md", "one\n");
  const open = (input: {
    commit: string;
    pushed?: { branch: string; commit: string };
    base?: string;
  }) =>
    service.open({
      identity,
      projectId,
      title: "Add one",
      body: "Why.",
      checkout: {
        repoPath: checkout,
        commit: input.commit,
        branch: "feature/x",
      },
      sessionId: SESSION,
      ...(input.pushed ? { pushed: input.pushed } : {}),
      ...(input.base ? { base: input.base } : {}),
      principal: "either",
    });

  const opened = await open({ commit: first, base: "trunk" });
  expect(opened).toEqual({
    url: "https://forge.test/pull/1",
    number: 1,
    branch: "work/feature-x-0a1b2c3d",
    commit: first,
    base: "trunk",
    created: true,
    push: "created",
  });
  // The pushed head is the checkout's commit, nothing else.
  expect(await tip(opened.branch)).toBe(first);
  expect(forge.host.createPullRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      head: "work/feature-x-0a1b2c3d",
      base: "trunk",
      title: "Add one",
      body: "Why.",
    }),
  );
  // The caller's own connection pushed, with write access.
  expect(forge.gitCalls).toContainEqual({
    token: "member-token",
    access: "write",
    remoteUrl: remote,
  });
  expect(audited).toEqual([
    {
      outcome: "allowed",
      metadata: expect.objectContaining({
        actor: "member",
        sessionId: SESSION,
        push: "created",
        input: {
          refs: [{ ref: "refs/heads/work/feature-x-0a1b2c3d", new: first }],
        },
      }),
    },
  ]);
  const pushed = { branch: opened.branch, commit: first };

  // A second call moves the same branch and returns the same pull request.
  const second = await commit(checkout, "two.md", "two\n");
  const updated = await open({ commit: second, pushed });
  expect(updated).toMatchObject({
    number: 1,
    url: opened.url,
    branch: opened.branch,
    created: false,
    push: "updated",
  });
  expect(await tip(opened.branch)).toBe(second);
  expect(forge.host.createPullRequest).toHaveBeenCalledTimes(1);

  // After a rebase the chat replaces its own branch, by a lease on the
  // commit it last pushed.
  await git(checkout, ["reset", "-q", "--hard", base]);
  const rebased = await commit(checkout, "one.md", "one, rebased\n");
  const replaced = await open({
    commit: rebased,
    pushed: { branch: opened.branch, commit: second },
  });
  expect(replaced).toMatchObject({
    number: 1,
    created: false,
    push: "replaced",
  });
  expect(await tip(opened.branch)).toBe(rebased);

  // Someone else pushed to the branch: their commit is never overwritten.
  await git(other, ["fetch", "-q", remote, opened.branch]);
  await git(other, ["checkout", "-q", "FETCH_HEAD"]);
  const theirs = await commit(other, "theirs.md", "theirs\n");
  await git(other, ["push", "-q", remote, `HEAD:refs/heads/${opened.branch}`]);
  await git(checkout, ["reset", "-q", "--hard", base]);
  const again = await commit(checkout, "one.md", "one, rebased again\n");
  await expect(
    open({
      commit: again,
      pushed: { branch: opened.branch, commit: rebased },
    }),
  ).rejects.toThrow(/someone else pushed to this branch/);
  expect(await tip(opened.branch)).toBe(theirs);
  expect(audited.at(-1)).toMatchObject({ outcome: "denied" });
  // Nor with a record that is not its own.
  await expect(open({ commit: again })).rejects.toThrow(/did not create it/);
  expect(await tip(opened.branch)).toBe(theirs);
  // The default branch and every other branch were never touched.
  expect(await tip("trunk")).toBe(base);
  expect(await tip("release")).toBe(base);
}, 60_000);

it("does not remember an existing branch as owned when it matches or moves forward", async () => {
  await forge.connectPersonal(identity, "member-token");
  const branch = "work/existing";
  const first = await commit(checkout, "one.md", "one\n");
  await git(checkout, ["push", "-q", remote, `HEAD:refs/heads/${branch}`]);
  const remember = vi.fn(async () => {});
  const open = (commit: string) =>
    service.openForChat({
      identity,
      projectId,
      sessionId: SESSION,
      title: "One",
      checkout: { repoPath: checkout, commit, branch },
      uncommitted: [],
      principal: "either",
      remember,
    });
  await open(first);
  const second = await commit(checkout, "two.md", "two\n");
  await open(second);
  expect(await tip(branch)).toBe(second);
  expect(remember).not.toHaveBeenCalled();
});

it("targets the branch the work started from when the repository has it, else the default branch", async () => {
  await forge.connectPersonal(identity, "member-token");
  await git(checkout, ["checkout", "-q", "-B", "work/11111111", "trunk"]);
  const head = await commit(checkout, "three.md", "three\n");
  const open = (base: string | undefined, branch: string) =>
    service.open({
      identity,
      projectId,
      title: "Three",
      checkout: { repoPath: checkout, commit: head, branch },
      sessionId: SESSION,
      ...(base ? { base } : {}),
      principal: "either",
    });
  // A branch of the repository is the base; its own name stays its name.
  expect(await open("release", "work/11111111")).toMatchObject({
    branch: "work/11111111",
    base: "release",
  });
  // A pull request head, a commit, a ref that is no branch there, and no
  // base at all leave the default branch.
  for (const [base, branch] of [
    ["refs/pull/7/head", "work/22222222"],
    [head, "work/33333333"],
    ["no-such-branch", "work/44444444"],
    [undefined, "work/55555555"],
  ] as const)
    expect(await open(base, branch), String(base)).toMatchObject({
      branch,
      base: "trunk",
    });
}, 60_000);

it("refuses with a plain reason when the project has no repository", async () => {
  await forge.connectPersonal(identity, "member-token");
  const head = await git(checkout, ["rev-parse", "HEAD"]);
  const attempt = service.open({
    identity,
    projectId: unlinkedId,
    title: "Nowhere",
    checkout: { repoPath: checkout, commit: head, branch: "work/66666666" },
    sessionId: SESSION,
    principal: "either",
  });
  await expect(attempt).rejects.toBeInstanceOf(PullRequestUnavailableError);
  await expect(attempt).rejects.toThrow(
    "This project is not connected to a repository, so there is nowhere to open a pull request. The branch is saved with this chat.",
  );
  expect(forge.gitCalls).toEqual([]);
});

it("needs what proposing a change needs: using the project, and a connection that may push", async () => {
  const head = await git(checkout, ["rev-parse", "HEAD"]);
  const open = (who: Identity) =>
    service.open({
      identity: who,
      projectId,
      title: "As someone",
      checkout: { repoPath: checkout, commit: head, branch: "work/77777777" },
      sessionId: SESSION,
      principal: "either",
    });
  // Someone with no part in the project.
  const stranger: Identity = {
    ...identity,
    externalUserId: "stranger",
    scope: [],
  };
  await expect(open(stranger)).rejects.toBeInstanceOf(AccessDeniedError);
  // A member with no connection of their own, and none of the organization's.
  const reader: Identity = {
    ...identity,
    externalUserId: "reader",
    scope: [],
    projectPermissions: [{ projectId, permission: "program:read" }],
  };
  await expect(open(reader)).rejects.toBeInstanceOf(CodeHostNotConnectedError);
  expect(forge.gitCalls).toEqual([]);
  expect(forge.host.createPullRequest).not.toHaveBeenCalled();
  // The organization's connection opens it for them: no `program:write`.
  await forge.connectService(
    {
      ...identity,
      externalUserId: "admin",
      controlPlanePermissions: ["connections:read", "connections:write"],
    },
    "org-token",
  );
  expect(await open(reader)).toMatchObject({ created: true, base: "trunk" });
  expect(forge.gitCalls).toContainEqual({
    token: "org-token",
    access: "write",
    remoteUrl: remote,
  });
}, 60_000);

it("records the pull request on the chat and hands the host what was pushed", async () => {
  await forge.connectPersonal(identity, "member-token");
  await git(checkout, ["checkout", "-q", "-B", "work/88888888", "trunk"]);
  const head = await commit(checkout, "four.md", "four\n");
  const recorded: unknown[] = [];
  const remembered: unknown[] = [];
  service.bindChats({
    record: async (input) => {
      recorded.push(input);
    },
  });
  const opened = await service.openForChat({
    identity,
    projectId,
    sessionId: SESSION,
    title: " Add four ",
    checkout: { repoPath: checkout, commit: head, branch: "work/88888888" },
    uncommitted: ["draft.md"],
    principal: "either",
    remember: async (pushed) => {
      remembered.push(pushed);
    },
  });
  expect(opened).toMatchObject({
    branch: "work/88888888",
    commit: head,
    created: true,
    uncommitted: ["draft.md"],
  });
  expect(opened.note).toContain("Not pushed, because not committed: draft.md");
  expect(opened.note).not.toMatch(/[–—]/);
  expect(remembered).toEqual([{ branch: "work/88888888", commit: head }]);
  expect(recorded).toEqual([
    {
      identity,
      projectId,
      sessionId: SESSION,
      pullRequest: {
        url: opened.url,
        number: opened.number,
        title: "Add four",
      },
    },
  ]);
}, 60_000);
