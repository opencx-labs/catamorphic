import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// Like Electron's binding: a frame id that isn't a number throws.
vi.mock("electron", () => ({
  webFrameMain: {
    fromId: (processId: unknown, routingId: unknown) => {
      if (typeof processId !== "number" || typeof routingId !== "number")
        throw new TypeError(
          "Error processing argument at index 1, conversion failure from undefined",
        );
      return undefined;
    },
  },
}));

const { WebNavigationEvents } = await import("./web-navigation.js");

class FakeContents extends EventEmitter {
  readonly id = 7;
  readonly mainFrame = { frameTreeNodeId: 1, osProcessId: 42 };
  isDestroyed() {
    return false;
  }
  getURL() {
    return "https://mail.example.com/";
  }
}

describe("WebNavigationEvents", () => {
  it("reports a load Electron refused before it started, which carries no frame ids", () => {
    const events: { name: string; details: Record<string, unknown> }[] = [];
    const navigation = new WebNavigationEvents((_profile, name, details) =>
      events.push({ name, details }),
    );
    const contents = new FakeContents();
    // @ts-expect-error A fake with only what the watcher reads.
    navigation.watch("profile", contents, () => true);
    // What webContents.loadURL emits when it refuses a load at once.
    expect(() =>
      contents.emit(
        "did-fail-load",
        {},
        -2,
        "ERR_FAILED",
        "https://mail.example.com/",
        true,
      ),
    ).not.toThrow();
    expect(events).toEqual([
      {
        name: "onErrorOccurred",
        details: expect.objectContaining({
          tabId: 7,
          frameId: 0,
          parentFrameId: -1,
          url: "https://mail.example.com/",
          error: "ERR_FAILED",
        }),
      },
    ]);
  });
});
