import type { IPty } from "@lydell/node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalLifecycle } from "./terminal-lifecycle.js";

function terminal() {
  let exit = (_event: { exitCode: number; signal?: number }) => {};
  const subscription = { dispose: vi.fn() };
  const pty: Pick<IPty, "kill" | "onExit"> = {
    kill: vi.fn(),
    onExit: (callback) => {
      exit = callback;
      return subscription;
    },
  };
  return { pty, exit: () => exit({ exitCode: 0 }), subscription };
}

afterEach(() => vi.useRealTimers());

describe("native terminal shutdown", () => {
  it("waits for exit callbacks, including terminals already killed by their tab", async () => {
    const lifecycle = new TerminalLifecycle();
    const first = terminal();
    const closedTab = terminal();
    lifecycle.track(first.pty);
    lifecycle.track(closedTab.pty);
    closedTab.pty.kill();
    const done = vi.fn();
    const draining = lifecycle.dispose().then(done);
    expect(lifecycle.disposed).toBe(true);
    expect(() => lifecycle.track(terminal().pty)).toThrow("shutting down");
    first.exit();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    closedTab.exit();
    await draining;
    expect(done).toHaveBeenCalledOnce();
    expect(closedTab.subscription.dispose).toHaveBeenCalledOnce();
    await lifecycle.dispose();
    expect(first.pty.kill).toHaveBeenCalledOnce();
  });

  it("escalates a stubborn shell and waits for its native exit", async () => {
    vi.useFakeTimers();
    const lifecycle = new TerminalLifecycle();
    const shell = terminal();
    lifecycle.track(shell.pty);
    const drained = lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(shell.pty.kill).toHaveBeenLastCalledWith("SIGKILL");
    shell.exit();
    await vi.runAllTimersAsync();
    await drained;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a terminal that never acknowledges exit instead of claiming cleanup", async () => {
    vi.useFakeTimers();
    const lifecycle = new TerminalLifecycle();
    lifecycle.track(terminal().pty);
    const assertion = expect(lifecycle.dispose()).rejects.toThrow(
      "did not finish",
    );
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
