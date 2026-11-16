import { execFileSync } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Entries untouched this long are removed. */
export const TURBO_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Past this size, the oldest entries go until the cache fits. */
export const TURBO_CACHE_MAX_BYTES = 8 * 1024 ** 3;

/**
 * The local cache Turbo writes for this checkout. Turbo shares one cache
 * among a repository's worktrees, in the main worktree's `.turbo/cache`,
 * unless TURBO_CACHE_DIR says otherwise.
 */
export function turboCacheDirectory(input: {
  rootPath: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const configured = (input.env ?? process.env).TURBO_CACHE_DIR;
  if (configured) return path.resolve(input.rootPath, configured);
  const commonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: input.rootPath, encoding: "utf8" },
  ).trim();
  return path.join(path.dirname(commonDir), ".turbo", "cache");
}

/**
 * Turbo never evicts its local cache: one shared by every worktree grew to
 * 13 GB over seven months. This removes entries (an archive with its
 * manifest and metadata) not written for {@link TURBO_CACHE_MAX_AGE_MS}, then
 * the oldest until the cache is under {@link TURBO_CACHE_MAX_BYTES}. A removed
 * entry is only a cache miss: the task runs again.
 */
export async function pruneTurboCache(input: {
  directory: string;
  now?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}): Promise<{ removedEntries: number; removedBytes: number }> {
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? TURBO_CACHE_MAX_AGE_MS;
  const maxBytes = input.maxBytes ?? TURBO_CACHE_MAX_BYTES;
  const names = await readdir(input.directory).catch(() => []);
  const entries = new Map<
    string,
    { files: string[]; bytes: number; modifiedAt: number }
  >();
  const files = names.flatMap((name) => {
    const hash =
      /^([0-9a-f]{16})(?:\.tar\.zst|-manifest\.json|-meta\.json)$/.exec(
        name,
      )?.[1];
    return hash ? [{ hash, file: path.join(input.directory, name) }] : [];
  });
  // In batches: a long-used cache holds tens of thousands of files.
  for (let start = 0; start < files.length; start += 512) {
    const batch = files.slice(start, start + 512);
    const infos = await Promise.all(
      batch.map(({ file }) => stat(file).catch(() => undefined)),
    );
    batch.forEach(({ hash, file }, index) => {
      const info = infos[index];
      if (!info?.isFile()) return;
      const entry = entries.get(hash) ?? {
        files: [],
        bytes: 0,
        modifiedAt: 0,
      };
      entry.files.push(file);
      entry.bytes += info.size;
      entry.modifiedAt = Math.max(entry.modifiedAt, info.mtimeMs);
      entries.set(hash, entry);
    });
  }
  const oldestFirst = [...entries.values()].sort(
    (left, right) => left.modifiedAt - right.modifiedAt,
  );
  let totalBytes = oldestFirst.reduce((sum, entry) => sum + entry.bytes, 0);
  let removedEntries = 0;
  let removedBytes = 0;
  for (const entry of oldestFirst) {
    if (now - entry.modifiedAt < maxAgeMs && totalBytes <= maxBytes) break;
    await Promise.all(entry.files.map((file) => rm(file, { force: true })));
    totalBytes -= entry.bytes;
    removedEntries += 1;
    removedBytes += entry.bytes;
  }
  return { removedEntries, removedBytes };
}

/** Prunes this checkout's shared Turbo cache, saying what it freed. */
export async function pruneCheckoutTurboCache(rootPath: string): Promise<void> {
  try {
    const directory = turboCacheDirectory({ rootPath });
    const { removedEntries, removedBytes } = await pruneTurboCache({
      directory,
    });
    if (removedEntries > 0)
      console.log(
        `Turbo cache: removed ${removedEntries} old entries (${(removedBytes / 1024 ** 3).toFixed(1)} GiB) from ${directory}`,
      );
  } catch (error) {
    console.warn(
      `Turbo cache was not pruned: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
