import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type { AttemptHost } from "@catamorphic/agent-protocol/runner";

/** The native state subpath a Codex thread's rollout lines are stored under. */
export const ROLLOUT_SUBPATH = "rollout";

/**
 * Mirrors a thread's rollout file into Work's native state (ADR 0198): each
 * poll appends the complete lines written since the last one. Codex writes
 * the file lazily and only ever appends, so a byte offset is the cursor.
 * Polls run one at a time, in order.
 */
export class RolloutMirror {
  /** Bytes taken: always the end of a complete line. */
  private offset: number;
  private chain: Promise<void> = Promise.resolve();
  /** The last line stored. */
  private last: JsonValue | undefined;
  /**
   * Where lines are stored: the attempt Codex serves now. A Codex kept
   * warm between attempts (ADR 0222) has none while idle, and what it
   * writes then is stored by the next attempt.
   */
  host: Pick<AttemptHost, "nativeState"> | undefined;

  constructor(
    private readonly input: {
      file: string;
      host: Pick<AttemptHost, "nativeState">;
      /** Bytes already stored (a resumed or restored thread's existing file). */
      offset: number;
    },
  ) {
    this.offset = input.offset;
    this.host = input.host;
  }

  /** Read and store new complete lines; never throws. */
  poll(): Promise<void> {
    this.chain = this.chain.then(() => this.read()).catch(() => {});
    return this.chain;
  }

  /**
   * Store lines until the turn's own end is among them (Codex records the
   * end of every turn), or `timeoutMs` passes: then everything the turn
   * wrote is stored, with no process shutdown to flush it.
   */
  async turnStored(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.poll();
      if (turnEnd(this.last) || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async read(): Promise<void> {
    const host = this.host;
    if (!host) return;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.input.file, "r");
    } catch {
      return;
    }
    let complete: Buffer | undefined;
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
      complete = completeLines(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    if (!complete) return;
    this.offset += complete.length;
    const entries = rolloutLines(complete.toString("utf8"));
    if (entries.length > 0) {
      this.last = entries.at(-1);
      await host.nativeState.append({
        subpath: ROLLOUT_SUBPATH,
        entries,
      });
    }
  }
}

/** A rollout line that ends a turn: completed, or aborted. */
function turnEnd(entry: JsonValue | undefined): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const payload = entry.payload;
  return (
    entry.type === "event_msg" &&
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload.type === "task_complete" || payload.type === "turn_aborted")
  );
}

/**
 * The complete lines at the start of `bytes`, through the last newline.
 * Split on the newline byte before decoding, which never occurs inside a
 * multi-byte character: a line still being written stays undecoded.
 */
export function completeLines(bytes: Buffer): Buffer | undefined {
  const end = bytes.lastIndexOf(0x0a);
  return end < 0 ? undefined : bytes.subarray(0, end + 1);
}

function rolloutLines(text: string): JsonValue[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map(rolloutEntry);
}

/** A rollout file's lines as stored entries. */
export async function readRollout(file: string): Promise<JsonValue[]> {
  return rolloutLines(await readFile(file, "utf8"));
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
