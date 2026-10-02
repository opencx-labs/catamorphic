import { open, stat } from "node:fs/promises";
import type { JsonObject } from "@catamorphic/agent-protocol";
import { isObject } from "../app-server.js";
import { type CodexTransportFactory, processTransport } from "../transport.js";
import {
  abstractTranscript,
  type CodexTranscript,
  type CodexTranscriptEntry,
  type TranscriptPlaceholders,
} from "./transcript.js";

/**
 * Records what crosses a real app-server process into a transcript. It
 * wraps the process transport, so the adapter under recording is the one
 * that ships. Rollout files Codex reports (`thread.path`) are watched, and
 * their growth is recorded just before the frame that followed it.
 */
export class CodexRecorder {
  private readonly entries: CodexTranscriptEntry[] = [];
  private last = Date.now();
  /** Rollout files and how much of each the transcript already holds. */
  private readonly files = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: CodexTransportFactory = processTransport,
  ) {}

  private push(entry: CodexTranscriptEntry): void {
    this.last = Date.now();
    this.entries.push(entry);
  }

  /** Queue work in arrival order: file reads are async, frames are not. */
  private enqueue(step: () => Promise<void> | void): void {
    this.chain = this.chain.then(step).catch(() => {});
  }

  private async growth(): Promise<void> {
    for (const [file, offset] of this.files) {
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        continue;
      }
      if (size <= offset) continue;
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        this.files.set(file, size);
        this.entries.push({
          file_append: { path: file, text: buffer.toString("utf8") },
        });
      } finally {
        await handle.close();
      }
    }
  }

  private async watch(file: string, baseline?: number): Promise<void> {
    if (this.files.has(file)) return;
    let size = baseline;
    if (size === undefined) size = 0;
    this.files.set(file, size);
  }

  readonly transport: CodexTransportFactory = (input) => {
    const spawned = { args: input.args, env: input.env };
    this.enqueue(() => this.push({ spawn: spawned }));
    const inner = this.inner({
      ...input,
      onMessage: (message) => {
        const at = Date.now();
        this.enqueue(async () => {
          for (const file of rolloutPaths(message)) await this.watch(file);
          await this.growth();
          this.entries.push({
            emit_inbound: message,
            afterMs: Math.max(0, at - this.last),
          });
          this.last = at;
        });
        // The adapter sees the frame only after the transcript holds it
        // and any file it depends on, keeping recorded order causal.
        void this.chain.then(() => input.onMessage(message));
      },
      onExit: (exit) => {
        this.enqueue(async () => {
          await this.growth();
          this.push({ runtime_exit: { code: exit.code, signal: exit.signal } });
        });
        void this.chain.then(() => input.onExit(exit));
      },
    });
    return {
      send: (message) => {
        // A resume or fork by path names a file the adapter wrote itself.
        const params = isObject(message.params) ? message.params : {};
        this.enqueue(async () => {
          if (typeof params.path === "string") {
            const size = await stat(params.path).then(
              (info) => info.size,
              () => 0,
            );
            this.files.set(params.path, size);
          }
          this.push({ expect_outbound: message });
        });
        void this.chain.then(() => inner.send(message));
      },
      close: () => {
        this.enqueue(() => this.push({ client_close: true }));
        void this.chain.then(() => inner.close());
      },
    };
  };

  /** The transcript so far, with machine-specific strings as placeholders. */
  async transcript(input: {
    scenario: string;
    description: string;
    cliVersion: string;
    placeholders: TranscriptPlaceholders;
  }): Promise<CodexTranscript> {
    await this.chain;
    return abstractTranscript(
      {
        provider: "codex",
        format: 1,
        cliVersion: input.cliVersion,
        protocolVersion: `app-server v2 (codex ${input.cliVersion}, experimental)`,
        scenario: input.scenario,
        description: input.description,
        entries: this.entries,
      },
      input.placeholders,
    );
  }
}

function rolloutPaths(message: JsonObject): string[] {
  const found: string[] = [];
  for (const holder of [message.result, message.params])
    if (isObject(holder) && isObject(holder.thread)) {
      const file = holder.thread.path;
      if (typeof file === "string" && file) found.push(file);
    }
  return found;
}
