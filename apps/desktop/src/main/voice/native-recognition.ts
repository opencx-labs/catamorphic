import { type ChildProcess, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { RecognitionStream, Recognized } from "./engine.js";

const replySchema = z.discriminatedUnion("ok", [
  z.object({
    protocol: z.literal(1),
    ok: z.literal(true),
    text: z.string(),
    confidence: z.number().finite().max(0),
  }),
  z.object({
    protocol: z.literal(1),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

const MAX_SAMPLES = 16_000 * 60;
const MAX_REPLY_BYTES = 256 * 1024;
const partialSchema = z.object({
  protocol: z.literal(1),
  type: z.literal("partial"),
  text: z.string(),
});

/** Apple speech recognition; no Work speech-to-text model or audio files. */
export class NativeRecognition {
  private readonly pending = new Map<ChildProcess, () => void>();
  private preparing: Promise<void> | null = null;
  private prepared = false;
  private disposed = false;
  private epoch = 0;
  private streaming: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      helperPath: string;
      locale?: string;
      spawnImpl?: typeof spawn;
      timeoutMs?: number;
      prepareTimeoutMs?: number;
    },
  ) {}

  /** Prepare Apple's language assets, or request Speech Recognition permission. */
  prepare(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Speech recognition stopped."));
    if (this.preparing) return this.preparing;
    const preparing: Promise<void> = this.run({ prepare: true }).then(
      () => {
        if (this.preparing === preparing) this.prepared = true;
      },
      (error: unknown) => {
        // A canceled preparation can reject after the next voice has started.
        if (this.preparing === preparing) this.preparing = null;
        throw error;
      },
    );
    this.preparing = preparing;
    return preparing;
  }

  /** Mono 16 kHz PCM, matching SpeechParts.recognize. Never downloads assets. */
  async recognize(samples: Float32Array): Promise<Recognized> {
    if (this.disposed) throw new Error("Speech recognition stopped.");
    if (samples.length > MAX_SAMPLES) {
      throw new Error(
        "Dictate in stretches of up to one minute, then try again.",
      );
    }
    let audible = false;
    for (const sample of samples) {
      if (!Number.isFinite(sample))
        throw new Error(
          "The microphone returned invalid audio. Try dictating again.",
        );
      if (Math.abs(sample) > 0.00001) audible = true;
    }
    if (!audible) return { text: "", confidence: 0 };
    // Copy the exact view before handing it to the subprocess, including subarrays.
    const audio = Buffer.from(
      new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
    );
    return this.run({ prepare: false, audio });
  }

  /** One held stream: PCM goes in immediately and revised text comes back live. */
  start(onPartial: (text: string) => void): RecognitionStream {
    const controller = new AbortController();
    const epoch = this.epoch;
    let frames: Buffer[] = [];
    let input: Writable | null = null;
    let ended = false;
    let samplesWritten = 0;
    const stopped = () =>
      controller.signal.aborted || this.disposed || this.epoch !== epoch;
    const working = Promise.all([this.prepare(), this.streaming]).then(
      async () => {
        if (stopped()) throw new Error("Speech recognition stopped.");
        try {
          return await this.run({
            prepare: false,
            signal: controller.signal,
            stream: {
              onPartial: (text) => {
                if (!stopped()) onPartial(text);
              },
              connect: (stdin) => {
                input = stdin;
                for (const frame of frames) stdin.write(frame);
                frames = [];
                if (ended) stdin.end();
              },
            },
          });
        } catch (cause) {
          // Assets or permission can change between holds. Retry preparation
          // after a real failure, but keep a successful check across cancellation.
          if (!stopped()) {
            this.prepared = false;
            this.preparing = null;
          }
          throw cause;
        }
      },
    );
    this.streaming = working.then(
      () => {},
      () => {},
    );
    const canceled = new Promise<Recognized>((_resolve, reject) =>
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Speech recognition stopped.")),
        { once: true },
      ),
    );
    const result = Promise.race([working, canceled]);
    // A held stream can fail before the person releases it.
    void result.catch(() => {});
    return {
      write: (samples) => {
        if (ended || stopped()) return;
        samplesWritten += samples.length;
        if (
          samplesWritten > MAX_SAMPLES ||
          samples.some((sample) => !Number.isFinite(sample))
        ) {
          controller.abort();
          throw new Error(
            "The microphone returned invalid or excessive audio. Try dictating again.",
          );
        }
        const frame = Buffer.from(
          new Uint8Array(
            samples.buffer,
            samples.byteOffset,
            samples.byteLength,
          ),
        );
        if (input) input.write(frame);
        else frames.push(frame);
      },
      finish: () => {
        if (!ended) {
          ended = true;
          input?.end();
        }
        return result;
      },
      cancel: () => {
        frames = [];
        controller.abort();
      },
    };
  }

  /** Stop current native work; the next voice can prepare and transcribe again. */
  cancel(): void {
    this.epoch += 1;
    this.streaming = Promise.resolve();
    if (!this.prepared) this.preparing = null;
    for (const cancel of [...this.pending.values()]) cancel();
  }

  /** Permanently release recognition when the voice worker ends. */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private run({
    prepare,
    audio,
    stream,
    signal,
  }: {
    prepare: boolean;
    audio?: Buffer;
    stream?: { onPartial(text: string): void; connect(input: Writable): void };
    signal?: AbortSignal;
  }): Promise<Recognized> {
    return new Promise((resolve, reject) => {
      const args = [
        ...(prepare ? ["--prepare"] : []),
        ...(stream ? ["--stream"] : []),
        ...(this.options.locale ? ["--locale", this.options.locale] : []),
      ];
      const child = (this.options.spawnImpl ?? spawn)(
        this.options.helperPath,
        args,
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const output: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let lines = "";
      const decoder = new StringDecoder("utf8");
      let finalReply: z.infer<typeof replySchema> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              prepare
                ? "macOS speech preparation timed out. Check your internet connection and Dictation in System Settings > Keyboard, then try again."
                : "macOS speech recognition timed out. Try dictating again.",
            ),
          ),
        prepare
          ? (this.options.prepareTimeoutMs ?? 300_000)
          : (this.options.timeoutMs ?? 90_000),
      );
      timeout.unref();

      const cleanup = () => {
        clearTimeout(timeout);
        this.pending.delete(child);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => fail(new Error("Speech recognition stopped."));
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
        // A stuck OS recognition or permission request must not outlive Work.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
        child.stdin?.destroy();
        child.kill("SIGTERM");
      };
      this.pending.set(child, () =>
        fail(new Error("Speech recognition stopped.")),
      );
      child.once("error", (error) =>
        fail(
          new Error(
            `Could not start macOS speech recognition. Restart Work and try again. ${error.message}`,
          ),
        ),
      );
      child.stdin?.on("error", (error: Error) =>
        fail(
          new Error(
            `Could not send audio to macOS speech recognition. ${error.message}`,
          ),
        ),
      );
      child.stderr?.resume();
      const readLine = (line: string) => {
        const value: unknown = JSON.parse(line);
        const partial = partialSchema.safeParse(value);
        if (finalReply)
          throw new Error("Unexpected speech data after completion.");
        if (partial.success) stream?.onPartial(partial.data.text);
        else finalReply = replySchema.parse(value);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_REPLY_BYTES) {
          fail(
            new Error(
              "macOS speech recognition returned too much data. Try dictating again.",
            ),
          );
          return;
        }
        if (!stream) output.push(chunk);
        else {
          lines += decoder.write(chunk);
          try {
            let end = lines.indexOf("\n");
            while (end >= 0) {
              const line = lines.slice(0, end);
              lines = lines.slice(end + 1);
              if (line.trim()) readLine(line);
              end = lines.indexOf("\n");
            }
          } catch {
            fail(
              new Error(
                "macOS speech recognition returned an invalid response.",
              ),
            );
          }
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        cleanup();
        try {
          if (stream) lines += decoder.end();
          if (stream && lines.trim()) readLine(lines);
          const value: unknown = stream
            ? finalReply
            : JSON.parse(Buffer.concat(output).toString("utf8"));
          const reply = replySchema.parse(value);
          if (!reply.ok) {
            reject(new Error(reply.error.message));
          } else if (code !== 0 || signal) {
            reject(
              new Error(
                "macOS speech recognition ended unexpectedly. Try dictating again.",
              ),
            );
          } else {
            resolve({
              text: reply.text,
              confidence: reply.text.trim() ? reply.confidence : 0,
            });
          }
        } catch {
          reject(
            new Error(
              "macOS speech recognition ended without a valid response. Restart Work and try again.",
            ),
          );
        }
      });
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        if (stream && child.stdin) stream.connect(child.stdin);
        else child.stdin?.end(audio);
      }
    });
  }
}
