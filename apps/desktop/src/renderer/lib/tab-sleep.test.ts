// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "./desktop-api.js";
import { type SleepCandidate, useTabSleep } from "./tab-sleep.js";

vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    // A minute lasts 10 ms: the default hour out of sight is 600 ms.
    browserSleepMinute: vi.fn(async () => 10),
    browserSleep: vi.fn(async () => "kept-1"),
    browserSleepRelease: vi.fn(async () => undefined),
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Sleep = ReturnType<typeof useTabSleep>;
let root: Root;
let sleep: Sleep;
/**
 * The screens the workspace has mounted: awake tabs only, each with what
 * it read as it mounted (a screen reads `resume` once, then keeps it).
 */
let mounted: Map<string, ReturnType<Sleep["resume"]>>;

function Probe({ tabs }: { tabs: SleepCandidate[] }) {
  sleep = useTabSleep({
    mountKey: "project",
    startAsleep: false,
    candidates: tabs,
    setting: "1h",
    blockerFor: async () => null,
    guestFor: () => 7,
  });
  const next = new Map<string, ReturnType<Sleep["resume"]>>();
  for (const { localId } of tabs) {
    if (sleep.asleep(localId)) continue;
    next.set(
      localId,
      mounted.has(localId) ? mounted.get(localId) : sleep.resume(localId),
    );
  }
  mounted = next;
  return null;
}
const tab = (localId: string, awake: boolean): SleepCandidate => ({
  localId,
  hasPage: true,
  awake,
  agentControlled: false,
});
const render = (tabs: SleepCandidate[]) =>
  act(async () => {
    root.render(createElement(Probe, { tabs }));
  });
/** Long enough out of sight for a sweep to put a hidden tab to sleep. */
const outOfSight = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1_200);
  });

beforeEach(() => {
  mounted = new Map();
  vi.useFakeTimers();
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

it("keeps a sleeping tab's page with main and hands it to the screen that wakes", async () => {
  await render([tab("front", true), tab("behind", false)]);
  expect([...mounted.keys()]).toEqual(["front", "behind"]);

  await outOfSight();
  // Asleep, the tab mounts no screen; main kept its page through its guest.
  expect(desktopApi.browserSleep).toHaveBeenCalledExactlyOnceWith({
    guestId: 7,
  });
  expect(sleep.asleep("behind")).toBe(true);
  expect([...mounted.keys()]).toEqual(["front"]);

  // Shown again: its screen mounts in that render, resuming from the page.
  await render([tab("front", false), tab("behind", true)]);
  expect(mounted.get("behind")).toEqual({
    snapshotId: "kept-1",
  });
  expect(sleep.asleep("behind")).toBe(false);
  // The woken page claims what main kept: nothing is released.
  expect(desktopApi.browserSleepRelease).not.toHaveBeenCalled();
  // A screen that never slept resumes from nothing.
  expect(mounted.get("front")).toBe(undefined);
});

it("releases what main kept for a tab closed in its sleep", async () => {
  await render([tab("front", true), tab("behind", false)]);
  await outOfSight();
  expect(sleep.asleep("behind")).toBe(true);

  await render([tab("front", true)]);
  expect(desktopApi.browserSleepRelease).toHaveBeenCalledExactlyOnceWith({
    snapshotId: "kept-1",
  });
});

it("wakes a tab by name with its page, and drops a page whose address changed", async () => {
  await render([tab("front", true), tab("behind", false)]);
  await outOfSight();

  // An agent reaches the sleeping tab: it wakes while still out of sight.
  act(() => sleep.wake("behind"));
  expect(mounted.get("behind")).toEqual({
    snapshotId: "kept-1",
  });

  await outOfSight();
  expect(sleep.asleep("behind")).toBe(true);
  act(() => sleep.discard("behind"));
  expect(desktopApi.browserSleepRelease).toHaveBeenCalledExactlyOnceWith({
    snapshotId: "kept-1",
  });
  await render([tab("front", false), tab("behind", true)]);
  expect(mounted.get("behind")).toEqual({
    snapshotId: null,
  });
});
