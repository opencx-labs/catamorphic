import type { RunnerFrame } from "@catamorphic/agent-protocol/runner";
import type { RunnerChannel, RunnerRead } from "./runner-channels.js";

/**
 * How long an item's streamed deltas (an answer, a command's output) gather
 * before they are recorded (ADR 0229): harnesses write in many small
 * pieces, and each read becomes a transaction, session events and a stream
 * message. Streams deliver no faster than the session feed polls (150 ms).
 */
export const STREAM_BATCH_MS = 100;
/** A read already carrying this many frames is recorded without waiting. */
export const STREAM_BATCH_MAX_FRAMES = 256;

/**
 * Batch a runner read of streamed deltas (ADR 0229). A read carrying only
 * deltas of items already streaming waits {@link STREAM_BATCH_MS} and takes
 * what arrived meanwhile with one more read that does not wait, so the
 * ingest records one append per item instead of one per delta. An item's
 * first delta is recorded at once, so its first words show without the
 * wait; so is a read with any other frame, an exit, or a full batch.
 * Frames keep their order, and the merged read ends where the second one
 * did (its cursor, and whether the runner exited).
 *
 * `streaming` holds the items whose deltas were recorded already, and
 * gains this read's. Returns null when `signal` aborts during the wait.
 */
export async function batchStreamedRead(input: {
  channel: Pick<RunnerChannel, "read">;
  read: RunnerRead;
  streaming: Set<string>;
  signal: AbortSignal;
  batchMs?: number;
}): Promise<RunnerRead | null> {
  const { read, streaming } = input;
  const keys = deltaKeys(read.frames);
  const batchable =
    !read.exited &&
    keys.length > 0 &&
    keys.length === read.frames.length &&
    read.frames.length < STREAM_BATCH_MAX_FRAMES &&
    keys.every((key) => streaming.has(key));
  for (const key of keys) streaming.add(key);
  if (!batchable) return read;
  await sleep(input.batchMs ?? STREAM_BATCH_MS, input.signal);
  if (input.signal.aborted) return null;
  const more = await input.channel.read({ cursor: read.cursor, waitMs: 0 });
  for (const key of deltaKeys(more.frames)) streaming.add(key);
  return {
    frames: [...read.frames, ...more.frames],
    diagnostics: [...read.diagnostics, ...more.diagnostics],
    cursor: more.cursor,
    exited: more.exited,
  };
}

/** The items a read's deltas stream to, one per delta frame. */
function deltaKeys(frames: readonly RunnerFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.type === "event" && frame.event.type === "item.delta"
      ? [frame.event.key]
      : [],
  );
}

/** Sleep, ending early when `signal` aborts. */
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
