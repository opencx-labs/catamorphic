import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

/** Archive only this job's task graph, not every historical source revision. */
export function pruneCiCache(root: string): number {
  const summaries = path.join(root, ".turbo/runs");
  const cache = path.join(root, ".turbo/cache");
  if (!existsSync(summaries) || !existsSync(cache)) return 0;
  const hashes = new Set<string>();
  for (const file of readdirSync(summaries).filter((file) =>
    file.endsWith(".json"),
  )) {
    const summary: { tasks: { hash: string }[] } = JSON.parse(
      readFileSync(path.join(summaries, file), "utf8"),
    );
    // Parse all summaries before deleting anything. Early failures without a
    // summary retain the restored archive rather than discarding useful work.
    for (const task of summary.tasks) hashes.add(task.hash);
  }
  if (hashes.size === 0) return 0;
  let removed = 0;
  for (const file of readdirSync(cache)) {
    const hash = /^([a-f0-9]{16})\.(?:json|tar\.zst)$/.exec(file)?.[1];
    if (hash && !hashes.has(hash)) {
      unlinkSync(path.join(cache, file));
      removed += 1;
    }
  }
  return removed;
}

if (import.meta.main) {
  console.log(
    `Removed ${pruneCiCache(path.resolve(import.meta.dirname, ".."))} obsolete task-cache files`,
  );
}
