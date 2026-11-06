import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "@catamorphic/agent-protocol";
import type { CodexExit, CodexTransportFactory } from "../transport.js";
import {
  type CodexTranscript,
  type CodexTranscriptEntry,
  materializeTranscript,
  type TranscriptPlaceholders,
} from "./transcript.js";

export interface CodexReplayOptions {
  /** Values for the transcript's `{{name}}` placeholders (at least `root`). */
  placeholders: TranscriptPlaceholders;
  /**
   * The longest pause before an inbound frame, in milliseconds. Order is
   * always kept; timing beyond this is compressed (default 20).
   */
  maxDelayMs?: number;
  /** How long to wait for the adapter's next frame (default 10 s). */
  waitMs?: number;
}

/**
 * A replay peer for the Codex app server: the one thing it replaces is the
 * process. Every frame the adapter sends must match the transcript's next
 * `expect_outbound`, in order; recorded inbound frames and file writes are
 * served in their recorded order around them. A mismatch stops the process
 * (the adapter sees it exit) and is reported by {@link CodexReplay.verify}.
 */
export class CodexReplay {
  private readonly entries: CodexTranscriptEntry[];
  private cursor = 0;
  private readonly failures: string[] = [];
  private readonly runs: Promise<void>[] = [];
  readonly transcript: CodexTranscript;

  constructor(
    transcript: CodexTranscript,
    private readonly options: CodexReplayOptions,
  ) {
    this.transcript = materializeTranscript(transcript, options.placeholders);
    this.entries = this.transcript.entries;
  }

  /** Pass as `createCodexAdapter({ transport })`. */
  readonly transport: CodexTransportFactory = (input) => {
    const outbound: JsonObject[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let exited = false;
    const exit = (info: CodexExit) => {
      if (exited) return;
      exited = true;
      input.onExit(info);
    };
    const nextOutbound = async (): Promise<
      JsonObject | "closed" | "timeout"
    > => {
      const deadline = Date.now() + (this.options.waitMs ?? 10_000);
      while (outbound.length === 0) {
        if (closed) return "closed";
        const left = deadline - Date.now();
        if (left <= 0) return "timeout";
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
      const frame = outbound.shift();
      return frame ?? "timeout";
    };
    const fail = (message: string) => {
      this.failures.push(
        `${this.transcript.scenario} entry ${this.cursor}: ${message}`,
      );
      exit({ code: 1, signal: null, stderr: `replay mismatch: ${message}` });
    };
    const spawn = this.entries[this.cursor];
    if (!spawn || !("spawn" in spawn)) {
      fail("the adapter started a process the transcript does not have");
    } else {
      this.cursor += 1;
      const actual = { args: input.args, env: input.env };
      if (!isDeepStrictEqual(json(actual), spawn.spawn))
        fail(
          `spawn differs\n  expected ${JSON.stringify(spawn.spawn)}\n  actual   ${JSON.stringify(actual)}`,
        );
    }
    const run = async () => {
      while (!exited && this.cursor < this.entries.length) {
        const entry = this.entries[this.cursor];
        if (!entry || "spawn" in entry) {
          fail("the transcript starts another process before this one exited");
          return;
        }
        if ("expect_outbound" in entry) {
          const frame = await nextOutbound();
          if (frame === "closed" || frame === "timeout") {
            fail(
              `expected ${JSON.stringify(entry.expect_outbound)} but the adapter ${frame === "closed" ? "closed the process" : "sent nothing"}`,
            );
            return;
          }
          if (!isDeepStrictEqual(json(frame), entry.expect_outbound)) {
            fail(
              `outbound frame differs\n  expected ${JSON.stringify(entry.expect_outbound)}\n  actual   ${JSON.stringify(frame)}`,
            );
            return;
          }
        } else if ("emit_inbound" in entry) {
          const delay = Math.min(
            entry.afterMs ?? 0,
            this.options.maxDelayMs ?? 20,
          );
          if (delay > 0)
            await new Promise((resolve) => setTimeout(resolve, delay));
          if (exited) return;
          input.onMessage(entry.emit_inbound);
        } else if ("file_append" in entry) {
          await mkdir(path.dirname(entry.file_append.path), {
            recursive: true,
          });
          await appendFile(entry.file_append.path, entry.file_append.text);
        } else if ("client_close" in entry) {
          const frame = await nextOutbound();
          if (frame !== "closed") {
            fail(
              frame === "timeout"
                ? "expected the adapter to close the process"
                : `expected the adapter to close the process but it sent ${JSON.stringify(frame)}`,
            );
            return;
          }
        } else if ("runtime_exit" in entry) {
          this.cursor += 1;
          if (outbound.length > 0)
            this.failures.push(
              `${this.transcript.scenario}: unexpected frames before exit: ${JSON.stringify(outbound)}`,
            );
          exit({ ...entry.runtime_exit, stderr: "" });
          return;
        }
        this.cursor += 1;
      }
      if (!exited) fail("the transcript ended while the process was running");
    };
    if (!exited) this.runs.push(run());
    return {
      send: (message) => {
        if (exited) return;
        outbound.push(message);
        wake?.();
      },
      close: () => {
        closed = true;
        wake?.();
      },
    };
  };

  /** Throws unless every entry was replayed and every frame matched. */
  async verify(): Promise<void> {
    await Promise.all(this.runs);
    if (this.cursor < this.entries.length)
      this.failures.push(
        `${this.transcript.scenario}: ${this.entries.length - this.cursor} transcript entries were never replayed, starting with ${JSON.stringify(this.entries[this.cursor])}`,
      );
    if (this.failures.length > 0) throw new Error(this.failures.join("\n"));
  }
}

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
