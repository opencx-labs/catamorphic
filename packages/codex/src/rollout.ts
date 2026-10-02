import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type { AttemptHost } from "@catamorphic/agent-protocol/runner";

/** The native state subpath a Codex thread's rollout lines are stored under. */
export const ROLLOUT_SUBPATH = "rollout";

/** Appends stay well under a runner frame's size limit. */
const APPEND_BATCH_CHARS = 256 * 1024;

/**
 * Mirrors a thread's rollout file into Work's native state (ADR 0197): each
 * poll appends the complete lines written since the last one. Codex writes
 * the file lazily and only ever appends, so a byte offset is the cursor.
 * Polls run one at a time, in order.
 */
export class RolloutMirror {
  private offset: number;
  private rest = "";
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      file: string;
      host: AttemptHost;
      /** Bytes already stored (a resumed or restored thread's existing file). */
      offset: number;
    },
  ) {
    this.offset = input.offset;
  }

  /** Read and store new complete lines; never throws. */
  poll(): Promise<void> {
    this.chain = this.chain.then(() => this.read()).catch(() => {});
    return this.chain;
  }

  private async read(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.input.file, "r");
    } catch {
      return;
    }
    let text = "";
    try {
      const { size } = await handle.stat();
      if (size <= this.offset) return;
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        this.offset,
      );
      this.offset += bytesRead;
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = (this.rest + text).split("\n");
    this.rest = lines.pop() ?? "";
    await appendRollout({
      host: this.input.host,
      subpath: ROLLOUT_SUBPATH,
      entries: lines.filter((line) => line.trim()).map(rolloutEntry),
    });
  }
}

/** Store entries in batches that stay well under a runner frame. */
export async function appendRollout(input: {
  host: AttemptHost;
  subpath: string;
  entries: JsonValue[];
}): Promise<void> {
  for (const batch of batches(input.entries))
    await input.host.nativeState.append({
      subpath: input.subpath,
      entries: batch,
    });
}

/** A rollout file's lines as stored entries. */
export async function readRollout(file: string): Promise<JsonValue[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map(rolloutEntry);
}

/**
 * A fork's history starts in its source's rollout (Codex records only
 * `forked_from_id` and an ordinal), so a fork keeps a copy of each
 * ancestor's rollout under `ancestor:<path relative to the home>`.
 */
const ANCESTOR_PREFIX = "ancestor:";

export function ancestorSubpath(statePath: string): string {
  return `${ANCESTOR_PREFIX}${statePath}`;
}

/** Where an ancestor's rollout goes in a home; undefined if it would leave it. */
export function ancestorFile(input: {
  home: string;
  subpath: string;
}): string | undefined {
  if (!input.subpath.startsWith(ANCESTOR_PREFIX)) return undefined;
  const relative = input.subpath.slice(ANCESTOR_PREFIX.length);
  const file = path.resolve(input.home, relative);
  return !path.isAbsolute(relative) &&
    file.startsWith(`${path.resolve(input.home)}${path.sep}`)
    ? file
    : undefined;
}

/** A rollout line as a stored entry: its JSON, or the raw line if it is not JSON. */
function rolloutEntry(line: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return line;
  }
}

function* batches(entries: JsonValue[]): Generator<JsonValue[]> {
  let batch: JsonValue[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = JSON.stringify(entry).length;
    if (batch.length > 0 && size + length > APPEND_BATCH_CHARS) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(entry);
    size += length;
  }
  if (batch.length > 0) yield batch;
}

/** Write stored rollout entries back to a file Codex can resume from. */
export async function writeRollout(input: {
  file: string;
  entries: JsonValue[];
}): Promise<number> {
  const text = input.entries
    .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    .map((line) => `${line}\n`)
    .join("");
  await mkdir(path.dirname(input.file), { recursive: true });
  await writeFile(input.file, text);
  return Buffer.byteLength(text);
}

export async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** Where a thread's rollout goes when Work restores it into a home. */
export function rolloutPath(input: {
  home: string;
  threadId: string;
  statePath?: string;
}): string {
  if (input.statePath && !path.isAbsolute(input.statePath)) {
    const resolved = path.resolve(input.home, input.statePath);
    if (resolved.startsWith(`${path.resolve(input.home)}${path.sep}`))
      return resolved;
  }
  // Codex finds a thread's file by its name, `rollout-<stamp>-<thread id>`.
  return path.join(
    input.home,
    "sessions",
    "restored",
    `rollout-restored-${input.threadId}.jsonl`,
  );
}

/** A rollout path relative to the home, when it lives there. */
export function statePathOf(input: {
  home: string;
  file: string;
}): string | undefined {
  const relative = path.relative(path.resolve(input.home), input.file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : undefined;
}
