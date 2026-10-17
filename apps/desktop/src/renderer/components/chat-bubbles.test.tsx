// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMenuEntry } from "../lib/chat-session-actions.js";
import { ChatBubbles, useStripFold } from "./chat-bubbles.js";
import { islandPath } from "./pill-island.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

function mount({
  menus = {},
}: {
  menus?: Record<string, ChatSessionMenuEntry[]>;
} = {}) {
  const onToggle = vi.fn();
  const onOpenAs = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ChatBubbles
        entries={[{ localId: "a", mode: "min" }]}
        labels={{ a: "Launch plan" }}
        icons={{}}
        forks={{}}
        signals={{}}
        unread={{}}
        attention={{}}
        menus={menus}
        collapsed={false}
        onFoldedChange={() => {}}
        onToggle={onToggle}
        onOpenAs={onOpenAs}
        onClose={() => {}}
        onMenuAction={() => {}}
        onNewChat={() => {}}
      />,
    );
  });
  const bubble = container.querySelector<HTMLButtonElement>(
    '[data-chat-bubble="a"] button[aria-label^="Open"]',
  );
  if (!bubble) throw new Error("bubble not rendered");
  return { bubble, container, onToggle, onOpenAs };
}

function click(target: HTMLElement, init: MouseEventInit) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("ChatBubbles open modifiers", () => {
  it("floats on a plain click and opens as a tab or to the side with the app's modifiers", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    const { bubble, onToggle, onOpenAs } = mount();
    click(bubble, {});
    expect(onToggle).toHaveBeenCalledWith("a");
    expect(onOpenAs).not.toHaveBeenCalled();

    click(bubble, { metaKey: true });
    expect(onOpenAs).toHaveBeenLastCalledWith("a", "tab");

    click(bubble, { metaKey: true, shiftKey: true });
    expect(onOpenAs).toHaveBeenLastCalledWith("a", "side");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("ChatBubbles context menu", () => {
  const archiveMenu = () =>
    [...document.querySelectorAll("[role=menuitem]")].find(
      (item) => item.textContent?.trim() === "Archive",
    );

  it("stays open while another surface scrolls and closes when the page scrolls", () => {
    const { bubble, container } = mount({
      menus: { a: [{ label: "Archive", action: "archive" }] },
    });
    act(() => {
      bubble.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      );
    });
    expect(archiveMenu()?.closest(".animate-pop-in")).toBeTruthy();

    // A streaming chat timeline following its output is not the bubble's
    // scroller; its scroll events must leave the menu open.
    const timeline = document.createElement("div");
    document.body.append(timeline);
    containers.push(timeline);
    act(() => {
      timeline.dispatchEvent(new Event("scroll"));
    });
    expect(archiveMenu()?.closest(".animate-pop-in")).toBeTruthy();

    act(() => {
      container.dispatchEvent(new Event("scroll"));
    });
    expect(archiveMenu()?.closest(".animate-pop-out")).toBeTruthy();
  });
});

describe("ChatBubbles fold", () => {
  // jsdom has no media queries; the strip asks for reduced motion as it folds.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface StripProps {
    folded: boolean;
    autoCollapse?: boolean;
    open?: boolean;
    working?: boolean;
  }
  /** The strip as the dock renders it: its fold derived by the host. */
  function Strip({
    folded,
    autoCollapse = false,
    open = false,
    working = false,
    onFoldedChange,
  }: StripProps & { onFoldedChange: (folded: boolean) => void }) {
    const fold = useStripFold({ autoCollapse, folded, chatOpen: open });
    return (
      <ChatBubbles
        entries={[{ localId: "a", mode: open ? "partial" : "min" }]}
        labels={{ a: "Launch plan" }}
        icons={{}}
        forks={{}}
        signals={working ? { a: { working: true } } : {}}
        unread={{}}
        attention={{}}
        menus={{}}
        activeLocalId="a"
        collapsed={fold.collapsed}
        onFoldedChange={(next) => {
          fold.choose(next);
          onFoldedChange(next);
        }}
        onToggle={() => {}}
        onClose={() => {}}
        onMenuAction={() => {}}
        onNewChat={() => {}}
      />
    );
  }

  /** The strip under one set of props; returns its state and a re-render. */
  function strip(props: StripProps) {
    const onFoldedChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (next: StripProps) =>
      act(() => {
        root.render(<Strip {...next} onFoldedChange={onFoldedChange} />);
      });
    render(props);
    const collapsed = () =>
      container
        .querySelector("[data-dock-rail]")
        ?.getAttribute("data-dock-collapsed");
    return { collapsed, render, container, onFoldedChange };
  }

  it("keeps the person's fold until they open it, beside an open chat only for as long as it is open", () => {
    const { collapsed, render } = strip({ folded: true });
    expect(collapsed()).toBe("true");
    render({ folded: true, open: true });
    expect(collapsed()).toBe("false");
    render({ folded: true, open: false });
    expect(collapsed()).toBe("true");
  });

  it("spins the folded bubble only while it shows", () => {
    const { container, render } = strip({ folded: false, working: true });
    const folded = () =>
      container.querySelector(
        'button[aria-label="Expand chat bubbles"] .animate-spin',
      );
    // Open, the strip keeps the folded bubble mounted but invisible.
    expect(folded()).toBeNull();
    render({ folded: true, working: true });
    expect(folded()).not.toBeNull();
  });

  it("folds behind a chat tab and returns to the person's choice after it", () => {
    const { collapsed, render } = strip({ folded: true });
    render({ folded: true, autoCollapse: true });
    expect(collapsed()).toBe("true");
    render({ folded: true, autoCollapse: false });
    expect(collapsed()).toBe("true");
    render({ folded: false, autoCollapse: true });
    expect(collapsed()).toBe("true");
    render({ folded: false, autoCollapse: false });
    expect(collapsed()).toBe("false");
  });

  it("asks to change the fold only from the person's own controls", () => {
    const { container, onFoldedChange, render } = strip({ folded: false });
    // A chat opening and a chat tab folding it change nothing saved.
    render({ folded: false, open: true });
    render({ folded: false, autoCollapse: true });
    render({ folded: false });
    expect(onFoldedChange).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse chat bubbles"]',
        )
        ?.click(),
    );
    expect(onFoldedChange).toHaveBeenLastCalledWith(true);
    render({ folded: true });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Expand chat bubbles"]',
        )
        ?.click(),
    );
    expect(onFoldedChange).toHaveBeenLastCalledWith(false);
    expect(onFoldedChange).toHaveBeenCalledTimes(2);
  });

  it("stays open by hand behind a chat tab until such a tab gains focus again", () => {
    const { collapsed, container, render } = strip({
      folded: false,
      autoCollapse: true,
    });
    expect(collapsed()).toBe("true");
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Expand chat bubbles"]',
        )
        ?.click(),
    );
    render({ folded: false, autoCollapse: true });
    expect(collapsed()).toBe("false");
    render({ folded: false });
    render({ folded: false, autoCollapse: true });
    expect(collapsed()).toBe("true");
  });

  it("says whether it is open, and hands focus to the control that replaces the one pressed", () => {
    const { container, render } = strip({ folded: false });
    const arrows = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse chat bubbles"]',
      );
    const expand = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand chat bubbles"]',
      );
    const items = container.querySelector("[data-bubble-items]");
    expect(arrows()?.getAttribute("aria-expanded")).toBe("true");
    expect(arrows()?.getAttribute("aria-controls")).toBe(items?.id);
    expect(expand()?.getAttribute("aria-controls")).toBe(items?.id);
    act(() => arrows()?.focus());
    act(() => arrows()?.click());
    render({ folded: true });
    expect(expand()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(expand());
    act(() => expand()?.click());
    render({ folded: false });
    expect(arrows()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(arrows());
  });
});

describe("ChatBubbles at an edge of the screen (ADR 0242)", () => {
  function pill({
    edge,
    notch = null,
    islandHover = true,
    collapsed = true,
    entries = [{ localId: "a", mode: "min" as const }],
  }: {
    edge: "bottom" | "left" | "right" | "top";
    notch?: { width: number; height: number } | null;
    islandHover?: boolean;
    collapsed?: boolean;
    entries?: { localId: string; mode: "min" }[];
  }) {
    const onFoldedChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <ChatBubbles
          detached
          edge={edge}
          notch={notch}
          islandHover={islandHover}
          entries={entries}
          labels={{ a: "Launch plan", b: "Release notes" }}
          icons={{}}
          forks={{}}
          signals={{}}
          unread={{}}
          attention={{}}
          menus={{}}
          collapsed={collapsed}
          onFoldedChange={onFoldedChange}
          voice={<button type="button" aria-label="Voice" />}
          onToggle={() => {}}
          onOpenAs={() => {}}
          onClose={() => {}}
          onMenuAction={() => {}}
          onNewChat={() => {}}
        />,
      );
    });
    return { container, onFoldedChange };
  }

  it("stands as a column on either side and lies along the bottom", () => {
    for (const edge of ["left", "right"] as const) {
      const { container } = pill({ edge });
      const rail = container.querySelector("[data-dock-rail]");
      expect(
        rail?.closest("[data-dock-edge]")?.getAttribute("data-dock-edge"),
      ).toBe(edge);
      expect(rail?.className).toContain("flex-col");
      expect(rail?.className).toContain(edge === "left" ? "left-3" : "right-3");
    }
    const { container } = pill({ edge: "bottom" });
    expect(
      container.querySelector("[data-dock-rail]")?.className,
    ).not.toContain("flex-col");
    // Without a notch the top is a plain top-centred pill, never an island.
    const top = pill({ edge: "top" });
    expect(top.container.querySelector("[data-pill-island]")).toBeNull();
    expect(
      top.container.querySelector("[data-dock-rail]")?.className,
    ).toContain("top-3");
  });

  it("wraps the notch: the microphone and the chats' handle in its wings, the strip under it", () => {
    const { container, onFoldedChange } = pill({
      edge: "top",
      notch: { width: 185, height: 32 },
    });
    const island = container.querySelector<HTMLElement>("[data-pill-island]");
    expect(island?.dataset.pillIsland).toBe("rest");
    expect(island?.style.height).toBe("32px");
    expect(
      container.querySelector('[data-island-wing="left"] [aria-label="Voice"]'),
    ).not.toBeNull();
    const handle = container.querySelector<HTMLButtonElement>(
      '[data-island-wing="right"] [data-island-handle]',
    );
    expect(handle?.getAttribute("aria-label")).toBe("Open the pill");
    const row = container.querySelector("[data-island-row]");
    expect(row?.getAttribute("aria-hidden")).toBe("true");
    expect(row?.querySelector('[aria-label="New chat"]')).not.toBeNull();
    act(() => handle?.click());
    expect(onFoldedChange).toHaveBeenCalledWith(false);
  });

  it("opens wide under the cutout when open, and counts its chats", () => {
    const { container } = pill({
      edge: "top",
      notch: { width: 185, height: 32 },
      collapsed: false,
      entries: [
        { localId: "a", mode: "min" },
        { localId: "b", mode: "min" },
      ],
    });
    const island = container.querySelector<HTMLElement>("[data-pill-island]");
    expect(island?.dataset.pillIsland).toBe("open");
    expect(island?.style.height).toBe(`${32 + 44 + 12}px`);
    expect(
      container.querySelector("[data-island-row]")?.getAttribute("aria-hidden"),
    ).toBe("false");
    expect(
      container.querySelector("[data-island-handle]")?.textContent,
    ).toContain("2");
  });

  it("opens on hover after a dwell, and only where hover is meant to open it", () => {
    vi.useFakeTimers();
    try {
      for (const islandHover of [true, false]) {
        const { container } = pill({
          edge: "top",
          notch: { width: 185, height: 32 },
          islandHover,
        });
        const island =
          container.querySelector<HTMLElement>("[data-pill-island]");
        if (!island) throw new Error("no island");
        act(() => {
          island.dispatchEvent(
            new MouseEvent("pointerover", {
              bubbles: true,
              relatedTarget: null,
            }),
          );
        });
        act(() => vi.advanceTimersByTime(60));
        expect(island.dataset.pillIsland).toBe("rest");
        act(() => vi.advanceTimersByTime(100));
        expect(island.dataset.pillIsland).toBe(islandHover ? "open" : "rest");
        act(() => {
          island.dispatchEvent(
            new MouseEvent("pointerout", {
              bubbles: true,
              relatedTarget: document.body,
            }),
          );
        });
        act(() => vi.advanceTimersByTime(400));
        expect(island.dataset.pillIsland).toBe("rest");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws every island state with the same commands, so its outline morphs", () => {
    const shape = (open: boolean) =>
      islandPath({
        canvas: 400,
        body: open ? 360 : 273,
        height: open ? 88 : 32,
        flare: open ? 10 : 7,
        radius: open ? 22 : 12,
      });
    const commands = (d: string) => d.replace(/[^A-Za-z]/g, "");
    expect(commands(shape(true))).toBe(commands(shape(false)));
    // It meets the top of the screen at y 0 on both sides, flared out.
    expect(shape(false).startsWith("M56.5,0")).toBe(true);
    expect(shape(false)).toMatch(/343\.5,0 Z$/);
  });
});
