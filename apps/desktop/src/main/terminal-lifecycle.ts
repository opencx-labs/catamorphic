import type { IPty } from "@lydell/node-pty";

type TerminalProcess = Pick<IPty, "kill" | "onExit">;

/** Track native processes independently of tabs, which disappear before exit. */
export class TerminalLifecycle {
  private readonly pending = new Map<TerminalProcess, Promise<void>>();
  private closing: Promise<void> | undefined;

  get disposed(): boolean {
    return this.closing !== undefined;
  }

  track(pty: TerminalProcess): void {
    if (this.disposed) throw new Error("Terminal support is shutting down");
    const exited = new Promise<void>((resolve) => {
      const subscription = pty.onExit(() => {
        subscription.dispose();
        this.pending.delete(pty);
        resolve();
      });
    });
    this.pending.set(pty, exited);
  }

  dispose(): Promise<void> {
    this.closing ??= this.drain();
    return this.closing;
  }

  private async drain(): Promise<void> {
    const signal = (name?: string) => {
      for (const pty of this.pending.keys()) pty.kill(name);
    };
    const exited = Promise.all(this.pending.values());
    const force = setTimeout(() => signal("SIGKILL"), 1000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      signal();
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error("Terminal processes did not finish shutting down"),
              ),
            4000,
          );
        }),
      ]);
      // Let native exit callbacks return before Electron frees the Node env.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      clearTimeout(force);
      clearTimeout(deadline);
    }
  }
}
