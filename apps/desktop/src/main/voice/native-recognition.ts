import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import type { Recognized } from "./engine.js";

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

/** Apple speech recognition; no Work speech-to-text model or audio files. */
export class NativeRecognition {
  private readonly pending = new Map<ChildProcess, () => void>();
  private preparing: Promise<void> | null = null;
  private disposed = false;

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
      () => {},
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

  /** Stop current native work; the next voice can prepare and transcribe again. */
  cancel(): void {
    this.preparing = null;
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
  }: {
    prepare: boolean;
    audio?: Buffer;
  }): Promise<Recognized> {
    return new Promise((resolve, reject) => {
      const args = [
        ...(prepare ? ["--prepare"] : []),
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
      };
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
        output.push(chunk);
      });
      child.once("close", (code, signal) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
        cleanup();
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(output).toString("utf8"),
          );
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
      child.stdin?.end(audio);
    });
  }
}
