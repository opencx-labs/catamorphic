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

/**
 * Replica memory (a), ADR 0193: guards a bare mirror on this process's own
 * disk. The mirror is a cache of commits, and each process has its own.
 */
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

/** How a base move ended (ADR 0178). */
export type BaseMoveOutcome =
  | { status: "moved"; head: string }
  /** The rebase stopped on conflicts and was undone; `head` is unchanged. */
  | { status: "conflict"; head: string; files: string[] };

const MOVE_AUTHOR = [
  "-c",
  "user.name=Work",
  "-c",
  "user.email=system@work.software",
] as const;

/**
 * Move a checkout from base `from` to base `to`, a commit pinned in the
 * mirror. `reset` discards the checkout's own commits and changes; `rebase`
 * replays its commits since `from` onto `to` (keeping uncommitted changes)
 * and, when that conflicts, puts everything back as it was so the caller
 * can tell the agent instead of losing work.
 */
export async function moveCheckoutBase(opts: {
  repoPath: string;
  mirrorPath: string;
  pin: string;
  from: string;
  to: string;
  update: "reset" | "rebase";
}): Promise<BaseMoveOutcome> {
  await copyFromMirror({
    mirrorPath: opts.mirrorPath,
    pin: opts.pin,
    repoPath: opts.repoPath,
    into: "refs/work/base",
  });
  const head = async () =>
    (await nativeGit(opts.repoPath, ["rev-parse", "HEAD"])).trim();
  if (opts.update === "reset") {
    await nativeGit(opts.repoPath, ["reset", "--quiet", "--hard", opts.to]);
    await nativeGit(opts.repoPath, ["clean", "-fdq"]);
    return { status: "moved", head: await head() };
  }
  try {
    await nativeGit(opts.repoPath, [
      ...MOVE_AUTHOR,
      "rebase",
      "--quiet",
      "--autostash",
      "--onto",
      opts.to,
      opts.from,
    ]);
    return { status: "moved", head: await head() };
  } catch {
    const files = (
      await nativeGit(opts.repoPath, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    await nativeGit(opts.repoPath, ["rebase", "--abort"]).catch(() => "");
    return { status: "conflict", head: await head(), files };
  }
}

/**
 * A packfile holding `head` and its history back to `base`, and the
 * commits a receiver must record as shallow. A sandbox seeded from it has
 * the real commits (so `git log`, `diff`, and pushes of new branches work)
 * without the repository's history before the base. With `tree`, the pack
 * also holds that tree whole: a session's working tree as last saved (ADR
 * 0344), which its sandbox puts back on top of `head`. With `holdsBase`
 * the receiver already has the base commit and its tree (it fetched them,
 * ADR 0353), so the pack holds only what the session added: its commits,
 * and the files of the saved tree that differ from the base's. `objects`
 * counts what the pack holds; an empty one need not travel.
 */
export async function buildSeedPack(opts: {
  repoPath: string;
  head: string;
  base: string;
  tree?: string;
  holdsBase?: boolean;
}): Promise<{ pack: Uint8Array; shallow: string[]; objects: number }> {
  for (const id of [opts.head, opts.base, ...(opts.tree ? [opts.tree] : [])])
    if (!COMMIT.test(id)) throw new Error("A seed pack names full object ids");
  const objects = path.resolve(
    opts.repoPath,
    (
      await nativeGit(opts.repoPath, ["rev-parse", "--git-path", "objects"])
    ).trim(),
  );
  if (/[\n"]/.test(objects))
    throw new Error("The repository's path cannot be packed from");
  const directory = await fs.mkdtemp(path.join(tmpdir(), "work-seed-"));
  try {
    // A repository of its own that borrows the copy's objects and ends
    // history at the base, so the walk below stops there without a ref or
    // a shallow file ever being written into the copy itself.
    await nativeGit(directory, [
      "init",
      "--bare",
      "--quiet",
      ...(opts.base.length === 64 ? ["--object-format=sha256"] : []),
    ]);
    await fs.writeFile(
      path.join(directory, "objects", "info", "alternates"),
      `${objects}\n`,
    );
    await fs.writeFile(path.join(directory, "shallow"), `${opts.base}\n`);
    // The base's tree is left out by name as well as its commit: a walk
    // that finds no commit to send (a head still on its base) never
    // reaches the base's tree to leave it out, and would send the saved
    // tree whole.
    const held = opts.holdsBase
      ? [
          `^${opts.base}`,
          `^${(await nativeGit(directory, ["rev-parse", "--verify", `${opts.base}^{tree}`])).trim()}`,
        ]
      : [opts.base];
    const pack = await gitOutput({
      cwd: directory,
      args: ["pack-objects", "--revs", "--stdout", "--quiet"],
      // The base itself too: a head that left it still needs it as its
      // ref. Left out, with everything it reaches, when the receiver
      // holds it.
      input: `${[...held, opts.head, ...(opts.tree ? [opts.tree] : [])].join("\n")}\n`,
    });
    return { pack, shallow: [opts.base], objects: packObjectCount(pack) };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** How many objects a packfile says it holds (its header's count). */
function packObjectCount(pack: Uint8Array): number {
  if (pack.byteLength < 12) return 0;
  return new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(
    8,
  );
}

/**
 * The bytes of a seed pack one uploaded part holds: a multiple of three,
 * so every part is whole base64 groups and the parts decode joined, and
 * small enough that a part's operation stays far under what a queue row
 * can carry (4 MiB of text).
 */
const SEED_PART_BYTES = 3 * 1024 * 1024;

/** Digits in a part's number: parts sort by name whatever their count. */
const SEED_PART_DIGITS = 6;

/**
 * A seed pack as the files to upload beside each other: base64, in parts
 * named `<name>.000000`, `<name>.000001`, and so on, which
 * {@link seedPackInstallScript} reads back in order. One file per upload
 * keeps every operation small whatever the pack's size, and each part is
 * encoded on its own, so no string grows with the pack either.
 */
export function seedPackParts(opts: {
  pack: Uint8Array;
  name: string;
}): { name: string; content: string }[] {
  const bytes = Buffer.from(
    opts.pack.buffer,
    opts.pack.byteOffset,
    opts.pack.byteLength,
  );
  const parts: { name: string; content: string }[] = [];
  for (let start = 0; start < bytes.byteLength; start += SEED_PART_BYTES)
    parts.push({
      name: `${opts.name}.${String(parts.length).padStart(SEED_PART_DIGITS, "0")}`,
      content: bytes
        .subarray(start, start + SEED_PART_BYTES)
        .toString("base64"),
    });
  return parts;
}

/**
 * Shell that installs a seed pack uploaded as base64 parts
 * (`<packFile>.000000`, ...; see {@link seedPackParts}) into the repository
 * in the current directory and records `shallow` commits. It leaves refs
 * and the working tree to the caller.
 */
export function seedPackInstallScript(opts: {
  packFile: string;
  shallow: readonly string[];
}): string {
  for (const commit of opts.shallow) {
    if (!COMMIT.test(commit)) throw new Error("Invalid shallow commit");
  }
  const gitDir = `"$(git rev-parse --git-dir)"`;
  const parts = `${shellQuote(opts.packFile)}.${"[0-9]".repeat(SEED_PART_DIGITS)}`;
  return [
    // Parts sort by name, and each is whole base64 groups, so they decode
    // as one stream.
    `cat ${parts} | base64 -d | git index-pack --stdin --fix-thin >/dev/null`,
    `rm -f ${parts}`,
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
