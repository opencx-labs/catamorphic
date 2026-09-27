import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeGit } from "./native-git.js";
import type { GitCredentials } from "./types.js";

/**
 * A session workspace's base (ADR 0178): the ref a caller asked for on the
 * project's linked remote and the commit it named when fetched.
 */
export interface WorkspaceBase {
  ref: string;
  commit: string;
}

const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Validate a ref a caller names: a branch, a tag, a full ref such as
 * `refs/pull/42/head`, or a full commit id. Anything that could be read as
 * an option or a refspec (`-x`, `a:b`, `+a`) is refused.
 */
export function parseWorkspaceRef(value: string): string {
  const ref = value.trim();
  if (COMMIT.test(ref)) return ref;
  if (
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    /[\s:~^?*[\\\u0000-\u001f\u007f+]/.test(ref)
  ) {
    throw new Error(
      `'${value}' is not a branch, tag, commit, or full ref such as refs/pull/42/head`,
    );
  }
  return ref;
}

/** Whether a ref names a commit id rather than a ref name. */
export function isCommitId(ref: string): boolean {
  return COMMIT.test(ref);
}

const mirrorLocks = new Map<string, Promise<unknown>>();

/** One Git operation per mirror at a time, in this process. */
async function withMirrorLock<T>(
  mirrorPath: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = mirrorLocks.get(mirrorPath) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  mirrorLocks.set(mirrorPath, settled);
  try {
    return await next;
  } finally {
    if (mirrorLocks.get(mirrorPath) === settled) mirrorLocks.delete(mirrorPath);
  }
}

async function ensureMirror(mirrorPath: string): Promise<void> {
  const exists = await fs.access(path.join(mirrorPath, "HEAD")).then(
    () => true,
    () => false,
  );
  if (exists) return;
  await fs.mkdir(mirrorPath, { recursive: true });
  await nativeGit(mirrorPath, ["init", "--bare", "--quiet"]);
  // Pinned refs keep what sessions stand on; nothing else is kept.
  await nativeGit(mirrorPath, ["config", "gc.auto", "0"]);
}

/**
 * Fetch `ref` from a network remote into the host's bare mirror of it and
 * pin the commit under `pin` (for example `refs/sessions/<id>`). The fetch
 * is incremental: the mirror keeps what earlier sessions fetched, so a pull
 * request head costs only its new objects. Credentials are sent as a header
 * for this one command and never written to the mirror's configuration.
 */
export async function fetchIntoMirror(opts: {
  mirrorPath: string;
  url: string;
  credentials?: GitCredentials;
  ref: string;
  pin: string;
}): Promise<{ commit: string }> {
  const ref = parseWorkspaceRef(opts.ref);
  assertPinRef(opts.pin);
  return withMirrorLock(opts.mirrorPath, async () => {
    await ensureMirror(opts.mirrorPath);
    const known =
      isCommitId(ref) &&
      (await nativeGit(opts.mirrorPath, [
        "cat-file",
        "-e",
        `${ref}^{commit}`,
      ]).then(
        () => true,
        () => false,
      ));
    if (!known) {
      await nativeGit(
        opts.mirrorPath,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          opts.url,
          `+${ref}:${opts.pin}`,
        ],
        opts.credentials ? { ...opts.credentials, url: opts.url } : undefined,
      ).catch((error: unknown) => {
        throw new Error(
          `Could not fetch '${ref}' from the project's remote: ${gitErrorText(error)}`,
        );
      });
    } else {
      await nativeGit(opts.mirrorPath, ["update-ref", opts.pin, ref]);
    }
    const commit = (
      await nativeGit(opts.mirrorPath, [
        "rev-parse",
        "--verify",
        `${opts.pin}^{commit}`,
      ])
    ).trim();
    return { commit };
  });
}

/** Drop a pin (a closed session's base). Missing is a no-op. */
export async function unpinMirrorRef(opts: {
  mirrorPath: string;
  pin: string;
}): Promise<void> {
  assertPinRef(opts.pin);
  const exists = await fs.access(path.join(opts.mirrorPath, "HEAD")).then(
    () => true,
    () => false,
  );
  if (!exists) return;
  await withMirrorLock(opts.mirrorPath, () =>
    nativeGit(opts.mirrorPath, ["update-ref", "-d", opts.pin]).catch(() => ""),
  );
}

/** Files that differ between two commits of the mirror, at most `limit`. */
export async function mirrorChangedFiles(opts: {
  mirrorPath: string;
  from: string;
  to: string;
  limit?: number;
}): Promise<{ files: string[]; total: number }> {
  const output = await nativeGit(opts.mirrorPath, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    opts.from,
    opts.to,
  ]).catch(() => "");
  const all = output.split("\0").filter(Boolean);
  return { files: all.slice(0, opts.limit ?? 50), total: all.length };
}

/**
 * Copy a pinned commit, with its history, from the mirror into a working
 * copy under `into`. Native Git negotiates what the copy already has, so a
 * copy seeded from the project's main receives only the difference.
 */
export async function copyFromMirror(opts: {
  mirrorPath: string;
  pin: string;
  repoPath: string;
  into: string;
}): Promise<void> {
  assertPinRef(opts.pin);
  assertPinRef(opts.into);
  await withMirrorLock(opts.mirrorPath, () =>
    nativeGit(opts.repoPath, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      opts.mirrorPath,
      `+${opts.pin}:${opts.into}`,
    ]),
  );
}

/**
 * A packfile holding `head` and its history back to `base`, and the
 * commits a receiver must record as shallow. A sandbox seeded from it has
 * the real commits (so `git log`, `diff`, and pushes of new branches work)
 * without the repository's whole history.
 */
export async function buildSeedPack(opts: {
  repoPath: string;
  head: string;
  base: string;
}): Promise<{ pack: Uint8Array; shallow: string[] }> {
  const depth = await nativeGit(opts.repoPath, [
    "rev-list",
    "--count",
    `${opts.base}..${opts.head}`,
  ])
    .then((count) => Number.parseInt(count.trim(), 10) + 1)
    .catch(() => 1);
  const directory = await fs.mkdtemp(path.join(tmpdir(), "work-seed-"));
  try {
    await nativeGit(directory, ["init", "--bare", "--quiet"]);
    // A private ref names the head for the shallow fetch below.
    const pin = `refs/work/seed/${process.pid}-${Date.now()}`;
    await nativeGit(opts.repoPath, ["update-ref", pin, opts.head]);
    try {
      await nativeGit(directory, [
        "fetch",
        "--quiet",
        "--no-tags",
        `--depth=${depth}`,
        `file://${path.resolve(opts.repoPath)}`,
        `+${pin}:refs/heads/main`,
      ]);
    } finally {
      await nativeGit(opts.repoPath, ["update-ref", "-d", pin]).catch(() => "");
    }
    const shallow = await fs
      .readFile(path.join(directory, "shallow"), "utf8")
      .then((text) => text.split("\n").filter(Boolean))
      .catch(() => []);
    const pack = await gitOutput({
      cwd: directory,
      args: ["pack-objects", "--revs", "--stdout", "--quiet"],
      input: `${opts.head}\n`,
    });
    return { pack, shallow };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Shell that installs a seed pack uploaded as base64 at `packFile` into the
 * repository in the current directory and records `shallow` commits. It
 * leaves refs and the working tree to the caller.
 */
export function seedPackInstallScript(opts: {
  packFile: string;
  shallow: readonly string[];
}): string {
  for (const commit of opts.shallow) {
    if (!COMMIT.test(commit)) throw new Error("Invalid shallow commit");
  }
  const gitDir = `"$(git rev-parse --git-dir)"`;
  return [
    `base64 -d < ${shellQuote(opts.packFile)} | git index-pack --stdin --fix-thin >/dev/null`,
    `rm -f ${shellQuote(opts.packFile)}`,
    ...(opts.shallow.length > 0
      ? [
          `touch ${gitDir}/shallow`,
          `printf '%s\\n' ${opts.shallow.join(" ")} >> ${gitDir}/shallow`,
          `sort -u -o ${gitDir}/shallow ${gitDir}/shallow`,
        ]
      : []),
  ].join(" && ");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function assertPinRef(ref: string): void {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error(`Invalid mirror ref '${ref}'`);
  }
}

function gitErrorText(error: unknown): string {
  const stderr =
    error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : "";
  const text = (stderr || (error instanceof Error ? error.message : ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/authorization/i.test(line))
    .slice(-2)
    .join(" ");
  return text || "the remote refused the request";
}

/** Run Git and collect its binary standard output (a pack may be large). */
function gitOutput(opts: {
  cwd: string;
  args: readonly string[];
  input?: string;
}): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", opts.cwd, ...opts.args],
      {
        encoding: "buffer",
        maxBuffer: 2 * 1024 * 1024 * 1024,
        timeout: 15 * 60_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(new Uint8Array(stdout));
      },
    );
    child.stdin?.end(opts.input ?? "");
  });
}
