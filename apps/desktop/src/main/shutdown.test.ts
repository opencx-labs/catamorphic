import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerDesktopShutdown } from "./shutdown.js";

function setup() {
  const events = new EventEmitter();
  const finalQuit = vi.fn();
  const app = {
    on: (
      name: "will-quit",
      listener: (event: { preventDefault(): void }) => void,
    ) => events.on(name, listener),
    quit: () => {
      const event = { preventDefault: vi.fn() };
      events.emit("will-quit", event);
      if (event.preventDefault.mock.calls.length === 0) finalQuit();
    },
    exit: finalQuit,
  };
  const shutdown = vi.fn(async () => {});
  const onError = vi.fn();
  const signals = new EventEmitter();
  registerDesktopShutdown({ app, shutdown, onError, signals });
  return { app, events, signals, shutdown, onError, finalQuit };
}

describe("desktop shutdown", () => {
  it.each(["SIGTERM", "SIGINT"])("drains services on %s", async (signal) => {
    const { signals, shutdown, finalQuit } = setup();
    signals.emit(signal);
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not tear down services when a window cancels quit", async () => {
    const { events, shutdown, finalQuit } = setup();
    events.emit("before-quit", { preventDefault: vi.fn() });
    // A renderer's beforeunload cancels closing, so will-quit never fires.
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    expect(finalQuit).not.toHaveBeenCalled();
  });

  it("waits for one shutdown before allowing the final quit", async () => {
    const { app, shutdown, finalQuit } = setup();
    let finish = () => {};
    shutdown.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    app.quit();
    app.quit();
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(finalQuit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledOnce());
  });

  it("reports a cleanup failure and still completes quit", async () => {
    const { app, shutdown, onError, finalQuit } = setup();
    const error = new Error("flush failed");
    shutdown.mockRejectedValue(error);
    app.quit();
    await vi.waitFor(() => expect(finalQuit).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(error);
    expect(finalQuit).toHaveBeenCalledWith(1);
  });
});

it("attempts every cleanup and waits for storage after a producer fails", async () => {
  const { shutdownDesktopServices } = await import("./shutdown.js");
  const calls: string[] = [];
  await expect(
    shutdownDesktopServices({
      steps: [
        {
          name: "first",
          dispose: () => {
            calls.push("first");
            throw new Error("broken");
          },
        },
        {
          name: "second",
          dispose: () => {
            calls.push("second");
          },
        },
        {
          name: "storage",
          dispose: async () => {
            await Promise.resolve();
            calls.push("storage");
          },
        },
      ],
    }),
  ).rejects.toThrow("did not complete cleanly");
  expect(calls).toEqual(["first", "second", "storage"]);
});
