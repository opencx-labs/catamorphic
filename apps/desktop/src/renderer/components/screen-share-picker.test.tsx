// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ScreenShareRequest } from "../../shared/screen-share.js";
import type { BrowserEntry } from "../lib/workspace-state.js";
import { ScreenShareHost } from "./screen-share-picker.js";

const listeners = vi.hoisted(() => ({
  request: [] as Array<(request: ScreenShareRequest) => void>,
}));
const desktop = vi.hoisted(() => ({
  onScreenShareRequest: vi.fn(
    (listener: (request: ScreenShareRequest) => void) => {
      listeners.request.push(listener);
      return () => {
        listeners.request = listeners.request.filter(
          (entry) => entry !== listener,
        );
      };
    },
  ),
  onScreenShareWithdrawn: vi.fn(() => () => {}),
  // Windows and screens never answer unless a test says otherwise.
  screenShareSources: vi.fn((): Promise<unknown> => new Promise(() => {})),
  screenShareThumbnails: vi.fn(async () => ({})),
  screenShareAnswer: vi.fn(async () => true),
  windowImage: vi.fn(async () => null),
}));

vi.mock("../lib/desktop-api.js", () => ({ desktopApi: desktop }));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const roots: Root[] = [];
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  listeners.request = [];
  desktop.screenShareSources.mockImplementation(() => new Promise(() => {}));
});

const page = (localId: string, title: string): BrowserEntry => ({
  localId,
  profileId: "profile",
  initialUrl: `https://${localId}.example/`,
  url: `https://${localId}.example/`,
  title,
  faviconUrl: null,
});

/** One project's host, as each project runtime of a window mounts it. */
function mountProject(input: {
  visible: boolean;
  tabs: BrowserEntry[];
  guests: Record<string, number>;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <StrictMode>
        <ScreenShareHost
          visible={input.visible}
          tabs={input.tabs}
          asleep={() => false}
          laidOut={() => false}
          guestIds={{ current: new Map(Object.entries(input.guests)) }}
          prepareTab={vi.fn()}
        />
      </StrictMode>,
    ),
  );
}

const ask = (guestId: number) =>
  act(() => {
    for (const listener of listeners.request)
      listener({
        id: `request-${guestId}`,
        guestId,
        origin: "https://meet.example",
        audio: false,
        portal: false,
      });
  });

const pickers = () =>
  [...document.querySelectorAll('[data-testid="screen-share-picker"]')].map(
    (picker) =>
      [...picker.querySelectorAll('[data-testid="screen-share-source"]')].map(
        (row) => row.textContent,
      ),
  );

it("asks only the asking page's project, with that project's tabs", () => {
  mountProject({
    visible: true,
    tabs: [page("a1", "Notes"), page("a2", "Meet A")],
    guests: { a1: 11, a2: 12 },
  });
  mountProject({
    visible: false,
    tabs: [page("b1", "Docs"), page("b2", "Meet B")],
    guests: { b1: 21, b2: 22 },
  });

  ask(22);
  expect(pickers()).toEqual([
    [
      expect.stringContaining("Docs"),
      expect.stringMatching(/Meet B.*This tab/),
    ],
  ]);
});

it("gives a page no project holds to the project on screen", () => {
  mountProject({
    visible: false,
    tabs: [page("a1", "Notes")],
    guests: { a1: 11 },
  });
  mountProject({
    visible: true,
    tabs: [page("b1", "Docs")],
    guests: { b1: 21 },
  });

  ask(99);
  expect(pickers()).toEqual([[expect.stringContaining("Docs")]]);
});

it("fills the screen pane under StrictMode, which mounts effects twice", async () => {
  desktop.screenShareSources.mockImplementation(async () => ({
    windows: [],
    screens: [
      {
        id: "screen:1:0",
        kind: "screen",
        name: "Built-in Display",
        thumbnail: null,
        icon: null,
      },
    ],
    timedOut: false,
    system: null,
    systemAudio: false,
  }));
  mountProject({
    visible: true,
    tabs: [page("a1", "Notes")],
    guests: { a1: 11 },
  });
  ask(11);
  await act(async () => {
    await Promise.resolve();
  });
  act(() =>
    document
      .querySelector<HTMLElement>('[data-testid="screen-share-kind-screen"]')
      ?.click(),
  );
  expect(
    [
      ...document.querySelectorAll(
        '[data-testid="screen-share-screens"] [data-testid="screen-share-source"]',
      ),
    ].map((card) => [card.textContent, card.getAttribute("aria-selected")]),
  ).toEqual([["Built-in Display", "true"]]);
});
