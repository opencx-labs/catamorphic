import { lstat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTestDirectory } from "./test-processes.js";

/** Written into each test run's temporary root, so a later run may expire it. */
export const TEST_RUN_MARKER = ".catamorphic-test-run";

/** Failed runs whose roots stay for diagnosis, newest first. */
export const PRESERVED_TEST_RUNS = 5;
/** Younger roots are never touched: a run may still be using its own. */
export const TEST_RUN_MIN_AGE_MS = 6 * 60 * 60 * 1000;
/** Older roots go even among the newest. */
export const TEST_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function markTestRunDirectory(directory: string): Promise<void> {
  await writeFile(path.join(directory, TEST_RUN_MARKER), "");
}

/**
 * Removes test-run roots beyond the {@link PRESERVED_TEST_RUNS} newest, and
 * any past {@link TEST_RUN_RETENTION_MS}. A failed check or desktop test run
 * keeps its root for diagnosis, and nothing removed it later: dozens
 * accumulated in a few days, each with its caches and fixtures. Only roots a
 * run created qualify (marked ones, and unmarked ones from before the marker
 * by their layout), and none younger than {@link TEST_RUN_MIN_AGE_MS}.
 */
export async function removeExpiredTestRuns(
  input: {
    parent?: string;
    now?: number;
    keep?: number;
    minAgeMs?: number;
    retentionMs?: number;
  } = {},
): Promise<string[]> {
  const parent = input.parent ?? tmpdir();
  const now = input.now ?? Date.now();
  const keep = input.keep ?? PRESERVED_TEST_RUNS;
  const minAgeMs = input.minAgeMs ?? TEST_RUN_MIN_AGE_MS;
  const retentionMs = input.retentionMs ?? TEST_RUN_RETENTION_MS;
  const entries = await readdir(parent, { withFileTypes: true }).catch(
    () => [],
  );
  const runs: { directory: string; modifiedAt: number }[] = [];
  for (const entry of entries) {
    // mkdtemp's suffix: `ct-` for check and test runs, `d` for desktop tests.
    if (!entry.isDirectory() || !/^(ct-|d)[A-Za-z0-9]{6}$/.test(entry.name))
      continue;
    const directory = path.join(parent, entry.name);
    const stat = await lstat(directory).catch(() => undefined);
    if (!stat?.isDirectory() || now - stat.mtimeMs < minAgeMs) continue;
    if (await isTestRunDirectory(directory))
      runs.push({ directory, modifiedAt: stat.mtimeMs });
  }
  runs.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const removed: string[] = [];
  for (const [index, run] of runs.entries()) {
    if (index < keep && now - run.modifiedAt < retentionMs) continue;
    try {
      await removeTestDirectory(run.directory);
      removed.push(run.directory);
    } catch {
      // Another user's, or not ours after all: leave it.
    }
  }
  return removed;
}

async function isTestRunDirectory(directory: string): Promise<boolean> {
  const kind = async (name: string) => {
    const stat = await lstat(path.join(directory, name)).catch(() => undefined);
    return stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : null;
  };
  if ((await kind(TEST_RUN_MARKER)) === "file") return true;
  const run = await Promise.all(
    ["logs", "tmp", "bun-cache", "turbo-cache", "xdg-cache"].map(kind),
  );
  if (run.every((found) => found === "directory")) return true;
  const desktop = await Promise.all(
    ["source", "manifests", "Dockerfile"].map(kind),
  );
  return (
    desktop[0] === "directory" &&
    desktop[1] === "directory" &&
    desktop[2] === "file"
  );
}
