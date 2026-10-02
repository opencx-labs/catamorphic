import type {
  HarnessAdapter,
  RunnerCommandFrame,
  RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { AttemptRunner } from "./runner.js";

/**
 * A runner in the host's own process: the desktop's harnesses and the
 * control plane's built-in agent (ADR 0196). Same protocol, no transport.
 * Its frames live only in memory, so the attempt ends with the process.
 */
export class InProcessRunner {
  private readonly frames: RunnerFrame[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly runner: AttemptRunner;
  readonly done: Promise<void>;

  constructor(input: {
    adapters: Readonly<Record<string, HarnessAdapter>>;
    version: string;
    local?: Record<string, unknown>;
  }) {
    this.runner = new AttemptRunner({
      ...input,
      write: (frame) => {
        this.frames.push(frame);
        for (const wake of this.waiters) wake();
        this.waiters.clear();
      },
    });
    this.done = this.runner.done;
  }

  send(frame: RunnerCommandFrame): void {
    // Commands cross a JSON boundary even in process, so nothing an adapter
    // keeps can alias the host's objects.
    this.runner.handle(JSON.parse(JSON.stringify(frame)) as RunnerCommandFrame);
  }

  /** Frames after `afterSeq`, waiting up to `waitMs` for the first. */
  async read(input: {
    afterSeq: number;
    waitMs: number;
  }): Promise<RunnerFrame[]> {
    const pending = () =>
      this.frames.filter((frame) => frame.seq > input.afterSeq);
    let ready = pending();
    if (ready.length > 0 || input.waitMs <= 0) return ready;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve();
      }, input.waitMs);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.add(wake);
    });
    ready = pending();
    return ready;
  }

  get exited(): boolean {
    return this.frames.at(-1)?.type === "exit";
  }
}
