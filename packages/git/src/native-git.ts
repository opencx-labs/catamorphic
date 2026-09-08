import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface NativeGitAuth {
  url: string;
  username: string;
  password: string;
}

/** Native Git runs outside the host event loop and never refreshes the index on reads. */
export async function nativeGit(
  cwd: string,
  args: readonly string[],
  auth?: NativeGitAuth,
): Promise<string> {
  // Large repository transfers need a different budget from local reads.
  const networkOperation = ["fetch", "push", "clone", "ls-remote"].includes(
    args[0] ?? "",
  );
  return (
    await execute("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        ...(auth
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `http.${auth.url}.extraHeader`,
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
            }
          : {}),
      },
      timeout: networkOperation ? 15 * 60_000 : 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout;
}

export async function nativeGitBytes(
  cwd: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<Uint8Array> {
  const command = execute("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  });
  if (input) command.child.stdin?.end(input);
  return new Uint8Array((await command).stdout);
}

export interface LocalCheckout {
  path: string;
  commonDirectory: string;
  branch: string | null;
  defaultBranch: string | null;
  remoteUrl: string | null;
  remoteBranch: string | null;
}

/** Resolve subfolders, symlink aliases and linked worktrees without modifying the checkout. */
export async function discoverCheckout(input: {
  path: string;
}): Promise<LocalCheckout> {
  const requested = await fs.realpath(input.path);
  const root = await fs.realpath(
    (await nativeGit(requested, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const common = (
    await nativeGit(root, ["rev-parse", "--git-common-dir"])
  ).trim();
  const branch =
    (await nativeGit(root, ["branch", "--show-current"])).trim() || null;
  const remoteName = branch
    ? (
        await nativeGit(root, [
          "config",
          "--get",
          `branch.${branch}.remote`,
        ]).catch(() => "")
      ).trim() || "origin"
    : "origin";
  const remoteUrl =
    remoteName === "."
      ? null
      : (
          await nativeGit(root, ["remote", "get-url", remoteName]).catch(
            () => "",
          )
        ).trim() || null;
  const remoteBranch = branch
    ? (
        await nativeGit(root, [
          "config",
          "--get",
          `branch.${branch}.merge`,
        ]).catch(() => "")
      )
        .trim()
        .replace(/^refs\/heads\//, "") || null
    : null;
  const defaultBranch =
    (
      await nativeGit(root, [
        "symbolic-ref",
        "--short",
        `refs/remotes/${remoteName}/HEAD`,
      ]).catch(() => "")
    )
      .trim()
      .replace(`${remoteName}/`, "") || null;
  return {
    path: root,
    commonDirectory: await fs.realpath(path.resolve(root, common)),
    branch,
    defaultBranch,
    remoteUrl,
    remoteBranch,
  };
}

/** Private publication refs never share the user's origin namespace. */
export const INTERNAL_REMOTE_PREFIX = "refs/catamorphic/published";
