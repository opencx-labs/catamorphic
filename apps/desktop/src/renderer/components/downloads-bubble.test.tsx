// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DownloadRecord } from "../../shared/downloads.js";
import { DownloadsBubble } from "./downloads-bubble.js";

const state = vi.hoisted<{ downloads: DownloadRecord[] }>(() => ({
  downloads: [],
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    windowProfile: async () => "profile",
  },
}));
vi.mock("../lib/downloads.js", async (original) => ({
  ...(await original<typeof import("../lib/downloads.js")>()),
  useDownloads: () => ({ downloads: state.downloads }),
}));
vi.mock("../lib/popover-dismiss.js", () => ({ usePopoverDismiss: () => {} }));
vi.mock("./pop-panel.js", () => ({
  PopPanel: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="downloads-popover">{children}</div> : null,
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const NOW = Date.UTC(2026, 10, 13);
const DAY = 24 * 60 * 60 * 1000;
const record = (id: string, at = NOW): DownloadRecord => ({
  id,
  filename: `${id}.txt`,
  url: `https://files.test/${id}`,
  host: "files.test",
  savePath: `/tmp/${id}.txt`,
  mimeType: "text/plain",
  totalBytes: 10,
  receivedBytes: 10,
  state: "completed",
  startedAt: at,
  finishedAt: at,
  exists: true,
  canResume: false,
});
let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(<DownloadsBubble onOpenAll={() => {}} onOpenFile={() => {}} />),
  );
const toggle = () =>
  act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="downloads-bubble"]')
      ?.click(),
  );
const dot = () => container.querySelector('[data-testid="downloads-unseen"]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("expires only the menu's settled entries after three days and keeps active downloads", async () => {
  state.downloads = [
    record("new"),
    record("old", NOW - 4 * DAY),
    {
      ...record("running", NOW - 4 * DAY),
      state: "progressing",
      finishedAt: null,
    },
    record("boundary", NOW - 3 * DAY + 1000),
  ];
  await render();
  await toggle();
  expect(container.textContent).toContain("new.txt");
  expect(container.textContent).toContain("running.txt");
  expect(container.textContent).not.toContain("old.txt");
  expect(container.textContent).toContain("boundary.txt");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).not.toContain("boundary.txt");
  expect(state.downloads).toHaveLength(4);
});

it("acknowledges completions while open and keeps the dot cleared across remounts", async () => {
  state.downloads = [record("first")];
  await render();
  expect(dot()).not.toBeNull();
  await toggle();
  expect(dot()).toBeNull();
  state.downloads = [record("second", NOW + 1000), ...state.downloads];
  await render();
  await toggle();
  expect(dot()).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(dot()).toBeNull();
  state.downloads = [record("third", NOW + 2000), ...state.downloads];
  await render();
  expect(dot()).not.toBeNull();
});

it("does not notify for expired history and follows another window's acknowledgement", async () => {
  state.downloads = [record("old", NOW - 4 * DAY)];
  await render();
  expect(dot()).toBeNull();
  state.downloads = [record("new"), ...state.downloads];
  await render();
  expect(dot()).not.toBeNull();
  await act(async () => {
    localStorage.setItem("downloads-seen-at:profile", String(NOW));
    window.dispatchEvent(
      new StorageEvent("storage", { key: "downloads-seen-at:profile" }),
    );
  });
  expect(dot()).toBeNull();
});
