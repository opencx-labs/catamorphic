import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The runner as one self-contained file that a sandbox runs with Bun or
 * Node (ADR 0198). Hosts upload it by content hash, so a sandbox never
 * runs a runner older than its host.
 */
export async function loadRunnerBundle(): Promise<{
  source: string;
  /** Short name for the file: the digest's first 16 hex characters. */
  hash: string;
  /** The full SHA-256 of the source, which a sandbox's copy must match. */
  digest: string;
}> {
  const source = await readFile(
    new URL("./runner.mjs", import.meta.url),
    "utf8",
  );
  const digest = createHash("sha256").update(source).digest("hex");
  return { source, hash: digest.slice(0, 16), digest };
}
