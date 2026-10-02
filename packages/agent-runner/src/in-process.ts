import type {
  HarnessAdapter,
  RunnerCommandFrame,
  RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { AttemptRunner } from "./runner.js";

/**
 * A runner in the host's own process: the desktop's harnesses and the
 * control plane's built-in agent (ADR 0197). Same protocol, no transport.
 * Its frames live only in memory, so the attempt ends with the process.
 */
export class InProcessRunner {
  /**
   * Frames not yet released, in order. A read's `afterSeq` is its reader's
   * stored cursor, so everything up to it was applied and is let go: memory
   * holds what the reader has not caught up on, not the whole attempt.
   */
  private readonly frames: RunnerFrame[] = [];
  private released = 0;
  private wroteExit = false;
  private readonly waiters = new Set<() => void>();
  private readonly runner: AttemptRunner;
  private killed = false;
  readonly done: Promise<void>;

  constructor(input: {
    adapters: Readonly<Record<string, HarnessAdapter>>;
    version: string;
    local?: Record<string, unknown>;
  }) {
    this.runner = new AttemptRunner({
      ...input,
      write: (frame) => {
        // A killed runner is gone like a dead process: nothing it says
        // after reaches anyone.
        if (this.killed) return;
        this.frames.push(frame);
        if (frame.type === "exit") this.wroteExit = true;
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

  /**
   * Frames after `afterSeq`, waiting up to `waitMs` for the first. Frames up
   * to `afterSeq` are released: a later read from before it is refused,
   * never answered with a gap.
   */
  async read(input: {
    afterSeq: number;
    waitMs: number;
  }): Promise<RunnerFrame[]> {
    if (input.afterSeq < this.released)
      throw new Error(
        `This runner already released its frames up to ${this.released}, so it cannot be read from ${input.afterSeq}.`,
      );
    this.released = input.afterSeq;
    let count = 0;
    while (count < this.frames.length) {
      const frame = this.frames[count];
      if (!frame || frame.seq > input.afterSeq) break;
      count += 1;
    }
    this.frames.splice(0, count);
    if (this.frames.length > 0 || input.waitMs <= 0) return [...this.frames];
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
    return [...this.frames];
  }

  /** Frames kept for the reader: those it has not read past yet. */
  get heldFrames(): number {
    return this.frames.length;
  }

  /**
   * Stop the attempt for good: its holder is gone, so nobody may read it
   * again. A reader still attached sees it exit.
   */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.runner.handle({ id: "kill", command: { kind: "stop" } });
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  get exited(): boolean {
    return this.killed || this.wroteExit;
  }
}
