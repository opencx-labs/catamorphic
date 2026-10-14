import type { RunnerFrame } from "@catamorphic/agent-protocol/runner";
import { afterEach, expect, it, vi } from "vitest";
import type { RunnerRead } from "../services/sessions/runner-channels.js";
import {
  batchStreamedRead,
  STREAM_BATCH_MAX_FRAMES,
  STREAM_BATCH_MS,
} from "../services/sessions/stream-batch.js";

afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
function delta(key: string, text: string): RunnerFrame {
  seq += 1;
  return {
    seq,
    type: "event",
    event: { type: "item.delta", key, field: "text", text },
  };
}
function completed(key: string): RunnerFrame {
  seq += 1;
  return {
    seq,
    type: "event",
    event: { type: "item.completed", key, status: "completed" },
  };
}
function readOf(
  frames: RunnerFrame[],
  extra: Partial<RunnerRead> = {},
): RunnerRead {
  return { frames, diagnostics: [], cursor: seq, exited: false, ...extra };
}

/** A channel whose next reads return `reads`, in order. */
function channelOf(...reads: RunnerRead[]) {
  const read = vi.fn(async (_input: { cursor: number; waitMs: number }) => {
    const next = reads.shift();
    if (!next) throw new Error("Unexpected read");
    return next;
  });
  return { read };
}

it("records an item's first delta at once, then batches what follows it", async () => {
  vi.useFakeTimers();
  const streaming = new Set<string>();
  const signal = new AbortController().signal;
  const first = readOf([delta("answer", "Hel")]);
  const channel = channelOf();
  // The first words show without waiting.
  expect(
    await batchStreamedRead({ channel, read: first, streaming, signal }),
  ).toBe(first);
  expect(channel.read).not.toHaveBeenCalled();
  expect(streaming.has("answer")).toBe(true);

  // Later deltas wait one batch and take what arrived meanwhile.
  const later = readOf([delta("answer", "lo")]);
  const meanwhile = readOf([delta("answer", " there"), delta("answer", ".")], {
    cursor: 900,
  });
  channel.read.mockResolvedValueOnce(meanwhile);
  let merged: RunnerRead | null | undefined;
  void batchStreamedRead({ channel, read: later, streaming, signal }).then(
    (read) => {
      merged = read;
    },
  );
  await vi.advanceTimersByTimeAsync(STREAM_BATCH_MS - 1);
  expect(merged).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(channel.read).toHaveBeenCalledWith({
    cursor: later.cursor,
    waitMs: 0,
  });
  expect(merged).toEqual({
    frames: [...later.frames, ...meanwhile.frames],
    diagnostics: [],
    cursor: 900,
    exited: false,
  });
});

it("keeps frames in order when the batch's second read carries other frames", async () => {
  vi.useFakeTimers();
  const streaming = new Set(["answer"]);
  const later = readOf([delta("answer", "Done")], { diagnostics: ["one"] });
  const meanwhile = readOf(
    [delta("answer", "!"), completed("answer"), delta("output", "$ ls")],
    { diagnostics: ["two"], cursor: 1_200 },
  );
  const channel = channelOf(meanwhile);
  const pending = batchStreamedRead({
    channel,
    read: later,
    streaming,
    signal: new AbortController().signal,
  });
  await vi.advanceTimersByTimeAsync(STREAM_BATCH_MS);
  expect(await pending).toEqual({
    frames: [...later.frames, ...meanwhile.frames],
    diagnostics: ["one", "two"],
    cursor: 1_200,
    exited: false,
  });
  // The command's output started inside the batch: its next delta batches.
  expect(streaming.has("output")).toBe(true);
});

it("ends the batch with the runner's exit when the second read finds it gone", async () => {
  vi.useFakeTimers();
  const later = readOf([delta("answer", "Bye")]);
  const gone = readOf([], { exited: true, cursor: 1_500 });
  const pending = batchStreamedRead({
    channel: channelOf(gone),
    read: later,
    streaming: new Set(["answer"]),
    signal: new AbortController().signal,
  });
  await vi.advanceTimersByTimeAsync(STREAM_BATCH_MS);
  expect(await pending).toMatchObject({
    frames: later.frames,
    cursor: 1_500,
    exited: true,
  });
});

it("gives up the batch when the turn is aborted during its wait", async () => {
  vi.useFakeTimers();
  const stop = new AbortController();
  const channel = channelOf();
  const pending = batchStreamedRead({
    channel,
    read: readOf([delta("answer", "Hel")]),
    streaming: new Set(["answer"]),
    signal: stop.signal,
  });
  await vi.advanceTimersByTimeAsync(STREAM_BATCH_MS / 2);
  stop.abort();
  expect(await pending).toBeNull();
  expect(channel.read).not.toHaveBeenCalled();
});

it("records at once a read with any other frame, an exit, or a full batch", async () => {
  const streaming = new Set(["answer"]);
  const signal = new AbortController().signal;
  const channel = channelOf();
  const mixed = readOf([delta("answer", "a"), completed("answer")]);
  const exited = readOf([delta("answer", "b")], { exited: true });
  const full = readOf(
    Array.from({ length: STREAM_BATCH_MAX_FRAMES }, () => delta("answer", "c")),
  );
  for (const read of [mixed, exited, full, readOf([])])
    expect(await batchStreamedRead({ channel, read, streaming, signal })).toBe(
      read,
    );
  expect(channel.read).not.toHaveBeenCalled();
});
