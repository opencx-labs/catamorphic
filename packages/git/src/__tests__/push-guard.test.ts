import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeGit } from "../native-git.js";
import { NativeProjectRepo } from "../native-project-repo.js";
import {
  assertPushAllowed,
  pushOwnBranch,
  pushToRemote,
  RemotePushRefusedError,
} from "../network.js";
import { syncWithNetworkRemote } from "../network-sync.js";

const AUTHOR = { name: "Work", email: "system@work.software" };
const author = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

/**
 * ADR 0170: Work never updates an attached repository's default branch or any
 * branch it did not create. These tests run against real bare remotes.
 */
describe("push guard for attached remotes", () => {
  let temp: string;
  let origin: string;
  let seed: string;
  let root: string;

  const refs = () =>
    nativeGit(origin, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  const commit = async (dir: string, file: string, content: string) => {
    await fs.writeFile(path.join(dir, file), content);
    await nativeGit(dir, ["add", "."]);
    await nativeGit(dir, [...author, "commit", "-m", file]);
    return (await nativeGit(dir, ["rev-parse", "HEAD"])).trim();
  };

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-push-guard-"));
    origin = path.join(temp, "origin.git");
    seed = path.join(temp, "seed");
    root = path.join(temp, "root");
    await fs.mkdir(origin);
    await fs.mkdir(seed);
    await nativeGit(origin, ["init", "--bare", "-b", "main"]);
    await nativeGit(seed, ["init", "-b", "main"]);
    await commit(seed, "readme.md", "shared");
    await nativeGit(seed, ["push", origin, "main", "main:refs/heads/feature"]);
    await nativeGit(temp, ["clone", origin, root]);
  });

  afterEach(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });

  it("allows only fresh work/ branches, never force, on attached remotes", () => {
    for (const remoteBranch of [
      "main",
      "feature",
      "work",
      "work/",
      "releases/work/x",
    ]) {
      expect(() =>
        assertPushAllowed({ ownership: "attached", remoteBranch }),
      ).toThrow(RemotePushRefusedError);
    }
    expect(() =>
      assertPushAllowed({ ownership: "attached", remoteBranch: "work/fix" }),
    ).not.toThrow();
    expect(() =>
      assertPushAllowed({
        ownership: "attached",
        remoteBranch: "work/fix",
        force: true,
      }),
    ).toThrow(RemotePushRefusedError);
    // A lease on the commit it replaces is the one exception (ADR 0345),
    // and only under work/.
    expect(() =>
      assertPushAllowed({
        ownership: "attached",
        remoteBranch: "work/fix",
        force: true,
        lease: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPushAllowed({
        ownership: "attached",
        remoteBranch: "main",
        force: true,
        lease: true,
      }),
    ).toThrow(RemotePushRefusedError);
    expect(() =>
      assertPushAllowed({ ownership: "owned", remoteBranch: "main" }),
    ).not.toThrow();
  });

  it("refuses the default branch and foreign branches before reaching the remote", async () => {
    await commit(root, "local.md", "local");
    const before = await refs();
    for (const native of [true, false]) {
      for (const remoteBranch of ["main", "feature", "other"]) {
        await expect(
          pushToRemote({
            repoPath: root,
            native,
            url: origin,
            ownership: "attached",
            ref: "HEAD",
            remoteBranch,
          }),
        ).rejects.toThrow(RemotePushRefusedError);
      }
      // A refspec in disguise is refused too.
      for (const [ref, remoteBranch] of [
        ["+HEAD", "work/x"],
        ["HEAD:refs/heads/main", "work/x"],
        ["HEAD", "work/x:refs/heads/main"],
        ["HEAD", "refs/heads/main"],
      ] as const) {
        await expect(
          pushToRemote({
            repoPath: root,
            native,
            url: origin,
            ownership: "attached",
            ref,
            remoteBranch,
          }),
        ).rejects.toThrow(RemotePushRefusedError);
      }
    }
    expect(await refs()).toBe(before);
  });

  it("pushes work/ branches to attached remotes and anything to owned ones", async () => {
    const local = await commit(root, "local.md", "local");
    await pushToRemote({
      repoPath: root,
      native: true,
      url: origin,
      ownership: "attached",
      ref: "HEAD",
      remoteBranch: "work/local",
    });
    expect(
      (await nativeGit(origin, ["rev-parse", "refs/heads/work/local"])).trim(),
    ).toBe(local);
    await pushToRemote({
      repoPath: root,
      native: true,
      url: origin,
      ownership: "owned",
      ref: "HEAD",
      remoteBranch: "main",
    });
    expect(
      (await nativeGit(origin, ["rev-parse", "refs/heads/main"])).trim(),
    ).toBe(local);
  });

  it("lets a chat create, move forward and replace only its own branch (ADR 0345)", async () => {
    const tip = async (branch: string) =>
      (await nativeGit(origin, ["rev-parse", `refs/heads/${branch}`])).trim();
    const own = (
      commitId: string,
      pushed?: { branch: string; commit: string },
    ) =>
      pushOwnBranch({
        repoPath: root,
        url: origin,
        ownership: "attached",
        commit: commitId,
        remoteBranch: "work/chat",
        ...(pushed ? { pushed } : {}),
      });

    // Never the default branch or another person's, whatever the record says.
    const first = await commit(root, "one.md", "one");
    for (const remoteBranch of ["main", "feature", "work", "+work/x"])
      await expect(
        pushOwnBranch({
          repoPath: root,
          url: origin,
          ownership: "attached",
          commit: first,
          remoteBranch,
          pushed: { branch: remoteBranch, commit: first },
        }),
      ).rejects.toThrow(RemotePushRefusedError);

    expect(await own(first)).toEqual({
      outcome: "created",
      recordOwnership: true,
    });
    expect(await tip("work/chat")).toBe(first);
    expect(await own(first, { branch: "work/chat", commit: first })).toEqual({
      outcome: "unchanged",
      recordOwnership: false,
    });

    // Moving forward overwrites nothing, whoever pushed the branch: the
    // agent may have pushed it itself through the gateway.
    const second = await commit(root, "two.md", "two");
    expect(await own(second)).toEqual({
      outcome: "updated",
      recordOwnership: false,
    });
    expect(await tip("work/chat")).toBe(second);

    // Replacing a branch is for the chat that pushed it, and no other.
    await nativeGit(root, ["reset", "-q", "--hard", first]);
    const foreign = await commit(root, "two.md", "two, another way");
    await expect(own(foreign)).rejects.toThrow(/did not create it/);
    await expect(
      own(foreign, { branch: "work/other", commit: second }),
    ).rejects.toThrow(/did not create it/);
    expect(await tip("work/chat")).toBe(second);

    // After a rebase the chat replaces what it last pushed, and only that.
    await nativeGit(root, ["reset", "-q", "--hard", first]);
    const rebased = await commit(root, "two.md", "two, rebased");
    expect(await own(rebased, { branch: "work/chat", commit: second })).toEqual(
      { outcome: "replaced", recordOwnership: true },
    );
    expect(await tip("work/chat")).toBe(rebased);

    // Someone else pushed there: nothing of theirs is overwritten.
    await nativeGit(seed, ["fetch", "-q", origin, "work/chat"]);
    await nativeGit(seed, ["checkout", "-q", "FETCH_HEAD"]);
    const theirs = await commit(seed, "theirs.md", "theirs");
    await nativeGit(seed, ["push", "-q", origin, "HEAD:refs/heads/work/chat"]);
    await nativeGit(root, ["reset", "-q", "--hard", first]);
    const again = await commit(root, "two.md", "two, rebased again");
    await expect(
      own(again, { branch: "work/chat", commit: rebased }),
    ).rejects.toThrow(/someone else pushed/);
    expect(await tip("work/chat")).toBe(theirs);

    // Built on top of theirs, it moves forward without any force.
    await nativeGit(root, ["fetch", "-q", origin, "work/chat"]);
    await nativeGit(root, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    const onTop = await commit(root, "three.md", "three");
    expect(await own(onTop, { branch: "work/chat", commit: rebased })).toEqual({
      outcome: "updated",
      recordOwnership: false,
    });
    expect(await tip("work/chat")).toBe(onTop);
  });

  it("refuses to push the advertised default even if it is a work/ branch", async () => {
    const previous = (await nativeGit(seed, ["rev-parse", "HEAD"])).trim();
    await nativeGit(seed, ["push", origin, "HEAD:refs/heads/work/default"]);
    await nativeGit(origin, [
      "symbolic-ref",
      "HEAD",
      "refs/heads/work/default",
    ]);
    const next = await commit(root, "one.md", "one");

    await expect(
      pushOwnBranch({
        repoPath: root,
        url: origin,
        ownership: "attached",
        commit: next,
        remoteBranch: "work/default",
        pushed: { branch: "work/default", commit: previous },
      }),
    ).rejects.toThrow(/default branch/);
    expect((await nativeGit(origin, ["rev-parse", "HEAD"])).trim()).toBe(
      previous,
    );
  });

  it("never pushes from sync in any state of an attached checkout", async () => {
    const repo = new NativeProjectRepo("project", root, async () => {});
    const sync = () =>
      syncWithNetworkRemote({
        dev: repo,
        url: origin,
        remoteBranch: "main",
        ownership: "attached",
        author: AUTHOR,
      });

    // Local commits on the tracked default branch.
    const initial = await refs();
    const local = await commit(root, "local.md", "local");
    expect(await sync()).toMatchObject({ status: "ahead", localSha: local });
    expect(await refs()).toBe(initial);

    // Someone else moved the default branch: histories diverge.
    await nativeGit(seed, ["pull", "--ff-only", origin, "main"]);
    await commit(seed, "theirs.md", "theirs");
    await nativeGit(seed, ["push", origin, "main"]);
    const shared = await refs();
    expect(await sync()).toMatchObject({ status: "diverged" });
    expect(await refs()).toBe(shared);
    expect((await nativeGit(root, ["rev-parse", "HEAD"])).trim()).toBe(local);

    // A person's own branch that was never pushed.
    await nativeGit(root, ["checkout", "-b", "mine"]);
    await commit(root, "mine.md", "mine");
    expect(await sync()).toMatchObject({ status: "ahead", remoteSha: null });
    expect(await refs()).toBe(shared);

    // Strictly behind over a clean tree still fast-forwards.
    await nativeGit(root, ["checkout", "feature"]);
    await nativeGit(seed, [
      "push",
      origin,
      `${(await nativeGit(seed, ["rev-parse", "HEAD"])).trim()}:refs/heads/feature`,
    ]);
    const after = await refs();
    expect(await sync()).toMatchObject({ status: "pulled" });
    expect(await refs()).toBe(after);
  });

  it("owned checkouts keep ADR 0044 sync: local commits are pushed", async () => {
    const repo = new NativeProjectRepo("project", root, async () => {});
    const local = await commit(root, "local.md", "local");
    const result = await syncWithNetworkRemote({
      dev: repo,
      url: origin,
      remoteBranch: "main",
      ownership: "owned",
      author: AUTHOR,
    });
    expect(result.status).toBe("pushed");
    expect(
      (await nativeGit(origin, ["rev-parse", "refs/heads/main"])).trim(),
    ).toBe(local);
  });
});
