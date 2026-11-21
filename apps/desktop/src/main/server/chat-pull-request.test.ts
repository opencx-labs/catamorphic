import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PullRequestsService } from "@catamorphic/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openChatPullRequest } from "./chat-pull-request.js";
import type { SessionCheckoutDescription } from "./session-checkouts.js";

const execute = promisify(execFile);
const git = async (cwd: string, args: readonly string[]) =>
  (
    await execute("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      ...args,
    ])
  ).stdout.trim();
const identity = { tenantId: "tenant", externalUserId: "person" };
const SESSION = "0a1b2c3d-4e5f-4789-abcd-ef0123456789";

type OpenForChat = Parameters<PullRequestsService["openForChat"]>[0];

describe("a desktop chat's pull request (ADR 0343)", () => {
  let root: string;
  let asked: OpenForChat[];
  let prepared: string[];
  const describeAs = (
    kind: SessionCheckoutDescription["kind"],
  ): SessionCheckoutDescription => ({
    path: root,
    kind,
    branch: null,
    present: true,
    available: true,
  });
  /** Core's service, as far as the desktop's part of the tool reaches it. */
  const pullRequests: Pick<
    PullRequestsService,
    "openForChat" | "remoteBranch"
  > = {
    remoteBranch: ({ branch, sessionId }) =>
      branch.startsWith("work/")
        ? branch
        : `work/${branch}-${(sessionId ?? "").slice(0, 8)}`,
    openForChat: async (input) => {
      asked.push(input);
      await input.remember({
        branch: pullRequests.remoteBranch({
          branch: input.checkout.branch,
          sessionId: input.sessionId,
        }),
        commit: input.checkout.commit,
      });
      return {
        url: "https://example.test/pull/1",
        number: 1,
        branch: "work/x",
        commit: input.checkout.commit,
        base: "main",
        created: asked.length === 1,
        uncommitted: [...input.uncommitted],
        note: "",
      };
    },
  };
  const open = (
    kind: SessionCheckoutDescription["kind"],
    sessionId = SESSION,
    checkout = root,
  ) =>
    openChatPullRequest({
      pullRequests,
      checkouts: {
        describe: async () => ({ ...describeAs(kind), path: checkout }),
        preparePullRequest: async (input) => {
          prepared.push(input.message);
          // The chat's own worktree is checkpointed: its changes become
          // commits before anything is pushed.
          await git(root, ["add", "-A"]);
          await git(root, ["commit", "-q", "-m", input.message]);
          return { path: root, branch: "work/0a1b2c3d" };
        },
      },
      identity,
      projectId: "project",
      sessionId,
      title: "Add notes",
      body: "Why.",
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "work-chat-pr-"));
    asked = [];
    prepared = [];
    await git(root, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(root, "readme.md"), "hello\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "Initial"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("pushes what the project folder committed and names the rest, never staging it", async () => {
    const head = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "draft.md"), "not committed\n");
    await writeFile(path.join(root, "readme.md"), "edited\n");
    const opened = await open("primary");
    expect(prepared).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      identity,
      projectId: "project",
      sessionId: SESSION,
      title: "Add notes",
      body: "Why.",
      checkout: { repoPath: root, commit: head, branch: "main" },
      uncommitted: ["readme.md", "draft.md"],
      principal: "either",
    });
    expect(asked[0]?.pushed).toBeUndefined();
    expect(opened.uncommitted).toEqual(["readme.md", "draft.md"]);
    // The person's pending work is as it was.
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(root, ["status", "--porcelain"])).toContain("draft.md");
  });

  it("checkpoints the chat's own worktree, and remembers what it pushed for the next call", async () => {
    await git(root, ["checkout", "-q", "-b", "work/0a1b2c3d"]);
    await writeFile(path.join(root, "notes.md"), "one\n");
    await open("managed");
    expect(prepared).toEqual(["Add notes"]);
    const first = await git(root, ["rev-parse", "HEAD"]);
    expect(asked[0]).toMatchObject({
      checkout: { commit: first, branch: "work/0a1b2c3d" },
      uncommitted: [],
    });
    expect(asked[0]?.pushed).toBeUndefined();
    // Kept where the commits are, for the lease of a later replacement.
    expect(
      await git(root, [
        "for-each-ref",
        "--format=%(objectname)",
        "refs/work/pushed",
      ]),
    ).toBe(first);

    await writeFile(path.join(root, "notes.md"), "two\n");
    await open("managed");
    const second = await git(root, ["rev-parse", "HEAD"]);
    expect(asked[1]).toMatchObject({
      checkout: { commit: second, branch: "work/0a1b2c3d" },
      pushed: { branch: "work/0a1b2c3d", commit: first },
    });
    expect(
      await git(root, [
        "for-each-ref",
        "--format=%(objectname)",
        "refs/work/pushed",
      ]),
    ).toBe(second);
  });

  it("does not share rewrite authority across chats or checkouts in one repository", async () => {
    await git(root, ["checkout", "-q", "-b", "work/topic"]);
    await open("primary");
    const otherSession = "1a1b2c3d-4e5f-4789-abcd-ef0123456789";
    await open("primary", otherSession);
    expect(asked[1]?.pushed).toBeUndefined();

    const otherCheckout = path.join(root, "other-checkout");
    await git(root, [
      "worktree",
      "add",
      "--force",
      otherCheckout,
      "work/topic",
    ]);
    await open("external", SESSION, otherCheckout);
    expect(asked[2]?.pushed).toBeUndefined();

    await open("primary");
    expect(asked[3]?.pushed).toMatchObject({ branch: "work/topic" });
  });

  it("refuses a worktree that is gone, before anything is pushed", async () => {
    await expect(
      openChatPullRequest({
        pullRequests,
        checkouts: {
          describe: async () => ({
            ...describeAs("external"),
            available: false,
          }),
          preparePullRequest: async () => ({ path: root, branch: "x" }),
        },
        identity,
        projectId: "project",
        sessionId: SESSION,
        title: "Add notes",
      }),
    ).rejects.toThrow(/unavailable/);
    expect(asked).toEqual([]);
  });
});
