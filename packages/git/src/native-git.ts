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

export interface LocalFolder {
  path: string;
  commonDirectory: string | null;
  branch: string | null;
  defaultBranch: string | null;
  remoteUrl: string | null;
  remoteBranch: string | null;
}

/** A .git directory or worktree pointer belongs to this folder, not an ancestor. */
export async function hasLocalGit({
  path: root,
}: {
  path: string;
}): Promise<boolean> {
  return fs.lstat(path.join(root, ".git")).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    },
  );
}

/** Resolve subfolders, symlink aliases and linked worktrees without modifying the checkout. */
export async function discoverLocalFolder(input: {
  path: string;
}): Promise<LocalFolder> {
  const requested = await fs.realpath(input.path);
  if (!(await fs.stat(requested)).isDirectory())
    throw new Error("Choose a folder to open as a project");
  // Check ancestors too: a subfolder of a damaged checkout must not be
  // accepted as a new plain folder, nor later initialized as a nested repo.
  let ancestor = requested;
  while (!(await hasLocalGit({ path: ancestor }))) {
    if (
      await fs.stat(path.join(ancestor, "HEAD")).then(
        () => true,
        () => false,
      )
    ) {
      if (
        (
          await nativeGit(ancestor, [
            "rev-parse",
            "--is-bare-repository",
          ]).catch(() => "")
        ).trim() === "true"
      )
        throw new Error("Choose a working folder, not a bare Git repository");
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor)
      return {
        path: requested,
        commonDirectory: null,
        branch: null,
        defaultBranch: null,
        remoteUrl: null,
        remoteBranch: null,
      };
    ancestor = parent;
  }
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
