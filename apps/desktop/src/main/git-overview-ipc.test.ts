import { EventEmitter } from "node:events";
import { app, ipcMain } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import type { GitOverviewSubscription } from "../shared/git.js";
import { registerGitOverviewSubscriptions } from "./git-overview-ipc.js";

const monitor = vi.hoisted(() => ({ subscribe: vi.fn(), dispose: vi.fn() }));
vi.mock("./git-overview-monitor.js", () => ({
  GitOverviewMonitor: class {
    subscribe = monitor.subscribe;
    dispose = monitor.dispose;
  },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), ipcMain: new EventEmitter() };
});
class Sender extends EventEmitter {
  send = vi.fn();
  isDestroyed = () => false;
}
beforeEach(() => {
  app.removeAllListeners();
  ipcMain.removeAllListeners();
  vi.clearAllMocks();
});

it("cancels a subscription whose root resolves after release or navigation", async () => {
  const pending: Array<(value: { root: string }) => void> = [];
  registerGitOverviewSubscriptions({
    resolve: () => new Promise((resolve) => pending.push(resolve)),
  });
  const sender = new Sender();
  ipcMain.emit("catamorphic:git-overview-subscribe", { sender }, "a", {
    projectId: "p",
  });
  ipcMain.emit("catamorphic:git-overview-unsubscribe", { sender }, "a");
  pending[0]?.({ root: "/project" });
  ipcMain.emit("catamorphic:git-overview-subscribe", { sender }, "b", {
    projectId: "p",
  });
  sender.emit("did-start-navigation", {}, "file:///app", false, true);
  pending[1]?.({ root: "/project" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(monitor.subscribe).not.toHaveBeenCalled();
  expect(sender.send).not.toHaveBeenCalled();
});

it("owns leases per renderer, cleans reloads without accumulating lifecycle listeners, and shuts down", async () => {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  monitor.subscribe.mockImplementation(({ listener }) => {
    listener({ available: true, worktrees: [] });
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  const resolve = vi.fn(async (_input: GitOverviewSubscription) => ({
    root: "/project",
  }));
  registerGitOverviewSubscriptions({ resolve });
  const first = new Sender();
  const second = new Sender();
  for (let i = 0; i < 12; i++) {
    ipcMain.emit(
      "catamorphic:git-overview-subscribe",
      { sender: first },
      "same-id",
      { projectId: "p" },
    );
    await vi.waitFor(() => expect(stops).toHaveLength(i + 1));
    first.emit("did-start-navigation", {}, "file:///reload", false, true);
    expect(stops[i]).toHaveBeenCalledOnce();
  }
  expect(first.listenerCount("destroyed")).toBe(1);
  expect(first.listenerCount("did-start-navigation")).toBe(1);
  ipcMain.emit(
    "catamorphic:git-overview-subscribe",
    { sender: second },
    "same-id",
    { projectId: "p" },
  );
  await vi.waitFor(() => expect(stops).toHaveLength(13));
  first.emit("destroyed");
  expect(stops[12]).not.toHaveBeenCalled();
  app.emit("before-quit", { preventDefault() {} });
  expect(stops[12]).toHaveBeenCalledOnce();
  expect(monitor.dispose).toHaveBeenCalledOnce();
});
