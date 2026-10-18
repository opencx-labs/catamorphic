// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENU_SEPARATOR, type MenuItem } from "../../shared/menu.js";
import { MenuPortal, placeMenu } from "./menu.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

const ENTRIES: MenuItem[] = [
  { label: "Copy", action: "copy" },
  { label: "Paste", action: "paste", disabledReason: "Nothing to paste" },
  MENU_SEPARATOR,
  { label: "Inspect", action: "inspect" },
];

/** A row that owns a menu, as a sidebar row or a page does. */
function Owner({
  onPick,
  onExited,
}: {
  onPick: (action: string) => void;
  onExited: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <div ref={anchor} data-testid="anchor">
      <MenuPortal
        open={open}
        at={{ pointer: { x: 100, y: 100 } }}
        anchor={anchor}
        entries={ENTRIES}
        onPick={(entry) => {
          onPick(entry.action);
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
        onExited={onExited}
      />
    </div>
  );
}

function mount() {
  const onPick = vi.fn();
  const onExited = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Owner onPick={onPick} onExited={onExited} />));
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("menu did not open");
  return { container, menu, onPick, onExited };
}

const closing = (menu: HTMLElement) =>
  menu.classList.contains("animate-pop-out");

describe("placeMenu", () => {
  const size = { width: 200, height: 300 };

  it("opens at the pointer, extending right and down", () => {
    expect(placeMenu({ pointer: { x: 100, y: 100 } }, size)).toEqual({
      left: 100,
      top: 100,
      origin: "top left",
    });
  });

  it("flips to the pointer's left and above it where the window ends", () => {
    expect(placeMenu({ pointer: { x: 900, y: 700 } }, size)).toEqual({
      left: 700,
      top: 400,
      origin: "bottom right",
    });
  });

  it("stays inside the window when neither side has room", () => {
    expect(
      placeMenu({ pointer: { x: 120, y: 790 } }, { width: 200, height: 900 }),
    ).toEqual({ left: 120, top: 8, origin: "bottom left" });
  });

  it("aligns under a control's right edge, and above it near the bottom", () => {
    const control = { top: 40, right: 300, bottom: 64, left: 276 };
    expect(placeMenu({ control }, size)).toEqual({
      left: 100,
      top: 68,
      origin: "top right",
    });
    const low = { top: 700, right: 300, bottom: 724, left: 276 };
    expect(placeMenu({ control: low }, size)).toEqual({
      left: 100,
      top: 396,
      origin: "bottom right",
    });
  });
});

describe("MenuPortal", () => {
  it("draws rules between groups and skips them and disabled entries from the keyboard", () => {
    const { menu } = mount();
    expect(menu.querySelectorAll("hr")).toHaveLength(1);
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    expect(items.map((item) => [item.textContent, item.disabled])).toEqual([
      ["Copy", false],
      ["Paste", true],
      ["Inspect", false],
    ]);
    expect(items[1]?.dataset.disabledReason).toBe("Nothing to paste");
    expect(document.activeElement).toBe(items[0]);
    act(() => {
      items[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[2]);
  });

  it("closes on a press anywhere else, which the shield under it takes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    containers.push(opener);
    opener.focus();
    const { menu } = mount();
    const shield = document.querySelector("[data-menu-shield]");
    if (!shield) throw new Error("no shield");
    // As Chromium sends a press: pointerdown, then mousedown.
    act(() => {
      shield.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(closing(menu)).toBe(false);
    const pressed = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      shield.dispatchEvent(pressed);
    });
    // The press moves no focus and reaches nothing under the shield.
    expect(pressed.defaultPrevented).toBe(true);
    expect(closing(menu)).toBe(true);
    expect(document.querySelector("[data-menu-shield]")).toBeNull();
    // Focus goes back to where it was as the menu opened.
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a press on what the window draws above the shield", () => {
    const { menu } = mount();
    const banner = document.createElement("button");
    document.body.append(banner);
    containers.push(banner);
    act(() => {
      banner.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(closing(menu)).toBe(true);
  });

  it("closes when focus leaves it, and leaves focus where it went", () => {
    const { menu } = mount();
    const palette = document.createElement("input");
    document.body.append(palette);
    containers.push(palette);
    act(() => palette.focus());
    expect(closing(menu)).toBe(true);
    expect(document.activeElement).toBe(palette);
  });

  it("closes on Escape and when the window loses focus", () => {
    const first = mount();
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(closing(first.menu)).toBe(true);
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    const second = mount();
    act(() => window.dispatchEvent(new Event("blur")));
    expect(closing(second.menu)).toBe(true);
  });

  it("closes when its anchor turns inert, as a closing sidebar does", async () => {
    const { container, menu } = mount();
    await act(async () => {
      container.setAttribute("inert", "");
      // Mutation observers report after the current task.
      await Promise.resolve();
    });
    expect(closing(menu)).toBe(true);
  });

  it("closes when its anchor is hidden, as a tab panel switching away is", async () => {
    const { container, menu } = mount();
    await act(async () => {
      container.hidden = true;
      await Promise.resolve();
    });
    expect(closing(menu)).toBe(true);
  });

  it("stays open while unrelated parts of the window change", async () => {
    const { menu } = mount();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    containers.push(elsewhere);
    await act(async () => {
      elsewhere.setAttribute("inert", "");
      elsewhere.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    expect(closing(menu)).toBe(false);
  });

  it("picks an entry and finishes its exit", () => {
    vi.useFakeTimers();
    const { menu, onPick, onExited } = mount();
    const inspect = [...menu.querySelectorAll("button")].find(
      (button) => button.textContent === "Inspect",
    );
    act(() => inspect?.click());
    expect(onPick).toHaveBeenCalledWith("inspect");
    expect(closing(menu)).toBe(true);
    act(() => vi.advanceTimersByTime(180));
    expect(onExited).toHaveBeenCalled();
  });

  it("moves rather than jumps when its rows change while it is open", () => {
    // Rows 28 px tall in a list with 8 px of padding; anything else none.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const rows = this.matches("[data-sidebar-menu] > div")
          ? this.querySelectorAll("[data-item-id]").length
          : 0;
        return DOMRect.fromRect({ height: rows ? rows * 28 + 8 : 0 });
      },
    );
    const animate = vi.fn(() => {
      const animation = new EventTarget();
      return Object.assign(animation, { cancel: vi.fn() });
    });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    Object.defineProperty(HTMLElement.prototype, "animate", {
      value: animate,
      configurable: true,
    });
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const show = (entries: MenuItem[]) =>
      act(() =>
        root.render(
          <MenuPortal
            open
            at={{ pointer: { x: 100, y: 100 } }}
            entries={entries}
            onPick={() => {}}
            onDismiss={() => {}}
            onExited={() => {}}
          />,
        ),
      );
    try {
      show([
        { label: "Built-in", action: "mic:a", detail: "Default" },
        { label: "Headset", action: "mic:b" },
      ]);
      // Opening is the menu's own entrance: nothing in it moves.
      expect(animate).not.toHaveBeenCalled();
      show([
        { label: "Built-in", action: "mic:a" },
        { label: "Headset", action: "mic:b", detail: "Default" },
        { label: "Earbuds", action: "mic:c" },
      ]);
      const detail = document.querySelector(
        '[data-item-id="mic:b:Headset"] [data-menu-detail]',
      );
      // The default fades in beside the headset, and the panel grows to
      // the new row rather than snapping.
      expect(animate.mock.contexts).toContain(detail);
      expect(animate.mock.calls).toContainEqual([
        [{ height: "64px" }, { height: "92px" }],
        expect.objectContaining({ duration: 200 }),
      ]);
      expect(
        [...document.querySelectorAll("[data-item-id]")].map((row) =>
          row.getAttribute("data-item-id"),
        ),
      ).toEqual(["mic:a:Built-in", "mic:b:Headset", "mic:c:Earbuds"]);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
      vi.restoreAllMocks();
    }
  });
});
