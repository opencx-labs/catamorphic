import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The runner as one self-contained file that a sandbox runs with Bun or
 * Node (ADR 0197). Hosts upload it by content hash, so a sandbox never
 * runs a runner older than its host.
 */
export async function loadRunnerBundle(): Promise<{
  source: string;
  hash: string;
}> {
  const source = await readFile(
    new URL("./runner.mjs", import.meta.url),
    "utf8",
  );
  return {
    source,
    hash: createHash("sha256").update(source).digest("hex").slice(0, 16),
  };
}
