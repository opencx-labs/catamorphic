// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notePagePress } from "../lib/app-focus.js";
import { type MenuAt, MenuPortal, menuAtPointer } from "./menu.js";
import {
  computeInspectorPosition,
  ResourceInspector,
  SETTLE_MAX_MS,
  useHoldInspector,
  useInspectorPending,
} from "./resource-inspector";

/** Content that opens a menu over the panel, as the project card's ⋯ does. */
function MenuOwner() {
  const [held, setHeld] = useState(false);
  useHoldInspector(held);
  return (
    <>
      <button type="button" data-open-menu onClick={() => setHeld(true)}>
        Open menu
      </button>
      <button type="button" data-close-menu onClick={() => setHeld(false)}>
        Close menu
      </button>
      {held &&
        createPortal(
          <div data-menu-shield>
            <button type="button" data-menu-item>
              Delete
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/** A chip with a right-click menu, as a chat rail's surface chip has. */
function ChipWithMenu() {
  const [at, setAt] = useState<MenuAt | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <ResourceInspector label="Terminal" content={<p>Preview</p>}>
      {(props) => (
        <>
          <button
            type="button"
            {...props}
            onContextMenu={(event) => {
              event.preventDefault();
              setAt(menuAtPointer(event));
              setOpen(true);
            }}
          >
            Terminal
          </button>
          {at && (
            <MenuPortal
              open={open}
              at={at}
              entries={[{ label: "Open in New Tab", action: "tab" }]}
              onPick={() => setOpen(false)}
              onDismiss={() => setOpen(false)}
              onExited={() => setAt(null)}
            />
          )}
        </>
      )}
    </ResourceInspector>
  );
}

/** Content whose read lands when the test says. */
function PendingContent({ pending }: { pending: boolean }) {
  useInspectorPending(pending);
  return <p>{pending ? "…" : "Loaded"}</p>;
}

/** A boundary crossing as the browser reports it, from one element to another. */
function cross(from: Element | null | undefined, to: Element | null) {
  from?.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: to }),
  );
  to?.dispatchEvent(
    new MouseEvent("pointerover", { bubbles: true, relatedTarget: from }),
  );
}

describe("ResourceInspector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelectorAll("[data-resource-inspector]").forEach((node) => {
      node.remove();
    });
    delete document.documentElement.dataset.focusModality;
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("opens immediately for focus and dismisses with Escape", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          content={<button type="button">Action</button>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    await act(async () => trigger?.focus());
    const dialog = document.querySelector('[role="dialog"]');
    // Focus can scroll a chat link into view after its focus event opens the card.
    await act(async () => container.dispatchEvent(new Event("scroll")));
    expect(dialog?.getAttribute("data-open")).toBe("true");
    await act(async () => dialog?.querySelector("button")?.focus());
    expect(dialog?.textContent).toContain("Action");
    expect(trigger?.getAttribute("aria-details")).toBe(dialog?.id);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-inspector-out-",
    );
  });

  it("removes the inspector during a drag so drop targets remain reachable", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="Project details" content={<p>Details</p>}>
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    await act(async () => container.querySelector("button")?.focus());
    expect(document.querySelector("[data-resource-inspector]")).not.toBeNull();
    await act(async () =>
      document.dispatchEvent(new Event("dragstart", { bubbles: true })),
    );
    expect(document.querySelector("[data-resource-inspector]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector("[data-resource-inspector]")).toBeNull();
    await act(async () =>
      document.dispatchEvent(new Event("dragend", { bubbles: true })),
    );
  });

  it("stays open while its own bounded content scrolls", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          content={<div className="h-[1000px]">Long project details</div>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    await act(async () => container.querySelector("button")?.focus());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.className).toContain("overflow-y-auto");
    await act(async () => dialog?.dispatchEvent(new Event("scroll")));
    expect(dialog?.className).toContain("animate-inspector-in-");
  });

  it("ignores sibling scrolling but dismisses when its ancestor scrolls", async () => {
    await act(async () => {
      root.render(
        <div data-scroll-parent>
          <div data-transcript />
          <ResourceInspector
            label="Terminal"
            content={<p>Preview</p>}
            pinOnClick
          >
            {(props) => (
              <button type="button" {...props}>
                Terminal
              </button>
            )}
          </ResourceInspector>
        </div>,
      );
    });
    await act(async () => container.querySelector("button")?.click());
    const dialog = document.querySelector("[data-resource-inspector]");
    expect(dialog?.getAttribute("data-open")).toBe("true");
    await act(async () =>
      container
        .querySelector("[data-transcript]")
        ?.dispatchEvent(new Event("scroll")),
    );
    expect(dialog?.getAttribute("data-open")).toBe("true");
    await act(async () =>
      container
        .querySelector("[data-scroll-parent]")
        ?.dispatchEvent(new Event("scroll")),
    );
    expect(dialog?.getAttribute("data-open")).toBeNull();
  });

  it("stays open for focus when the pointer leaves the trigger, and closes on blur", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="File preview" content={<p>Linked notes</p>}>
          {(props) => (
            <button type="button" {...props}>
              Notes
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    await act(async () => trigger?.focus());
    expect(dialog()?.getAttribute("data-open")).toBe("true");
    // React derives enter and leave from pointerover and pointerout.
    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent("pointerover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      trigger?.dispatchEvent(
        new MouseEvent("pointerout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");

    await act(async () => {
      trigger?.blur();
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.className).toContain("animate-inspector-out-");
  });

  it("leaves a clicked trigger's preview to the pointer", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="File preview" content={<p>Linked notes</p>}>
          {(props) => (
            <button type="button" {...props}>
              Notes
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    const pointer = (type: string) =>
      trigger?.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
      );
    // A press focuses its target later in the same task, after microtasks.
    await act(async () => {
      pointer("pointerdown");
      await Promise.resolve();
      trigger?.focus();
      vi.advanceTimersByTime(0);
    });
    expect(dialog()).toBeNull();
    await act(async () => {
      pointer("pointerover");
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
    await act(async () => {
      pointer("pointerout");
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.className).toContain("animate-inspector-out-");
  });

  it("stays open for focus in its panel when the pointer crosses it", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          content={<button type="button">Action</button>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    // Tab moved focus: the keyboard leads (lib/focus-modality).
    document.documentElement.dataset.focusModality = "keyboard";
    await act(async () => trigger?.focus());
    await act(async () => {
      dialog()?.querySelector("button")?.focus();
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
    await act(async () => {
      for (const type of ["pointerover", "pointerout"])
        dialog()?.dispatchEvent(
          new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
        );
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
  });

  it("leaves a pressed button's focus in its panel to the pointer", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          content={<button type="button">Copy</button>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    await act(async () => {
      cross(document.body, trigger);
      vi.advanceTimersByTime(1_000);
    });
    const button = dialog()?.querySelector("button");
    // Pressed: Chromium focuses the button, the pointer leads.
    document.documentElement.dataset.focusModality = "pointer";
    await act(async () => {
      cross(trigger, button ?? null);
      button?.focus();
      button?.click();
    });
    await act(async () => {
      cross(button, document.body);
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.className).toContain("animate-inspector-out-");
  });

  it("pins on click and dismisses on an outside pointer", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Session details"
          content={<button type="button">Archive</button>}
          pinOnClick
        >
          {(props) => (
            <button type="button" {...props}>
              Status
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    await act(async () => trigger?.click());
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-inspector-in-",
    );

    await act(async () =>
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-inspector-out-",
    );
  });

  it("stays open under its own menu, whose shield takes presses and Escape", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="Project details" content={<MenuOwner />}>
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    const pointer = (target: Element | null | undefined, type: string) =>
      target?.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
      );
    await act(async () => {
      pointer(trigger, "pointerover");
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
    const opener =
      dialog()?.querySelector<HTMLButtonElement>("[data-open-menu]");
    await act(async () => {
      cross(trigger, opener ?? null);
      opener?.click();
    });
    // The shield covers the panel. It sits inside the panel in React's
    // tree, so crossing onto it never leaves the panel there.
    await act(async () => {
      cross(opener, document.querySelector("[data-menu-shield]"));
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
    // A press on the shield only closes the menu; Escape is the menu's.
    await act(async () => {
      pointer(document.querySelector("[data-menu-shield]"), "pointerdown");
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
    // With the menu gone and the pointer elsewhere, the panel goes too.
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>("[data-close-menu]")?.click(),
    );
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.className).toContain("animate-inspector-out-");
  });

  it("stays open when its menu closes with the pointer resting on it", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="Project details" content={<MenuOwner />}>
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent("pointerover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      vi.advanceTimersByTime(1_000);
    });
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>("[data-open-menu]")?.click(),
    );
    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent("pointerout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      // The press that closes the menu lands over the panel.
      window.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 40, clientY: 40 }),
      );
    });
    // jsdom lays nothing out; the window would find the panel there.
    const inside = dialog()?.querySelector("[data-close-menu]") ?? null;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number) => (x === 40 && y === 40 ? inside : null),
    });
    try {
      await act(async () =>
        dialog()
          ?.querySelector<HTMLButtonElement>("[data-close-menu]")
          ?.click(),
      );
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(dialog()?.getAttribute("data-open")).toBe("true");
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("leaves the card to the pointer when its menu closes after arrowing through it", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="Project details" content={<MenuOwner />}>
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    const shield = () => document.querySelector("[data-menu-shield]");
    await act(async () => {
      cross(document.body, trigger);
      vi.advanceTimersByTime(1_000);
    });
    const opener =
      dialog()?.querySelector<HTMLButtonElement>("[data-open-menu]");
    // The ⋯ menu opens from a click, and the pointer moves onto it.
    document.documentElement.dataset.focusModality = "pointer";
    await act(async () => {
      cross(trigger, opener ?? null);
      opener?.click();
    });
    await act(async () => cross(opener, shield()));
    // An arrow key moves focus through its entries: the keyboard leads.
    document.documentElement.dataset.focusModality = "keyboard";
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-menu-item]")?.focus(),
    );
    // A click away closes the menu, which hands focus back to the ⋯.
    document.documentElement.dataset.focusModality = "pointer";
    await act(async () => {
      shield()?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      opener?.focus();
    });
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>("[data-close-menu]")?.click(),
    );
    // The pointer is elsewhere: the focus the keyboard gave it holds nothing.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.className).toContain("animate-inspector-out-");
  });

  it("keeps the card for keyboard focus its menu hands back", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="Project details" content={<MenuOwner />}>
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    document.documentElement.dataset.focusModality = "keyboard";
    await act(async () => trigger?.focus());
    const opener =
      dialog()?.querySelector<HTMLButtonElement>("[data-open-menu]");
    await act(async () => {
      opener?.focus();
      opener?.click();
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-menu-item]")?.focus(),
    );
    // Escape closes the menu, and focus goes back to the ⋯ in the card.
    await act(async () => opener?.focus());
    await act(async () =>
      dialog()?.querySelector<HTMLButtonElement>("[data-close-menu]")?.click(),
    );
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(dialog()?.getAttribute("data-open")).toBe("true");
  });

  it("opens no card when a right-click menu hands focus back to its trigger", async () => {
    await act(async () => root.render(<ChipWithMenu />));
    const chip = container.querySelector("button");
    document.documentElement.dataset.focusModality = "pointer";
    // A right-click presses and focuses the chip, then opens its menu.
    await act(async () => {
      chip?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      chip?.focus();
      vi.advanceTimersByTime(0);
    });
    await act(async () => {
      chip?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    // A press away closes the menu, which hands focus back to the chip.
    const shield = document.querySelector("[data-menu-shield]");
    await act(async () => {
      shield?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      shield?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(chip);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(document.querySelector("[data-resource-inspector]")).toBeNull();
  });

  it("starts its warmup while the pointer rests on the trigger", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          warmup={<span data-warmup />}
          content={<p>Details</p>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    const pointer = (type: string) =>
      trigger?.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
      );
    const warm = () => container.querySelector("[data-warmup]");
    // Passing over starts nothing.
    await act(async () => {
      pointer("pointerover");
      vi.advanceTimersByTime(60);
    });
    expect(warm()).toBeNull();
    await act(async () => {
      pointer("pointerout");
      vi.advanceTimersByTime(1_000);
    });
    expect(warm()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Resting a moment starts the reads; the panel takes over from them.
    await act(async () => {
      pointer("pointerover");
      vi.advanceTimersByTime(150);
    });
    expect(warm()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(warm()).toBeNull();
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute("data-open"),
    ).toBe("true");
  });

  it("closes on a press inside a page and when its trigger turns inert", async () => {
    await act(async () => {
      root.render(
        <div data-list>
          <ResourceInspector label="Project details" content={<p>Details</p>}>
            {(props) => (
              <button type="button" {...props}>
                Project
              </button>
            )}
          </ResourceInspector>
        </div>,
      );
    });
    const trigger = container.querySelector("button");
    const dialog = () => document.querySelector('[role="dialog"]');
    const open = async () => {
      await act(async () => {
        cross(document.body, trigger);
        vi.advanceTimersByTime(1_000);
      });
      expect(dialog()?.getAttribute("data-open")).toBe("true");
    };
    await open();
    await act(async () => notePagePress());
    expect(dialog()?.getAttribute("data-open")).toBeNull();
    await act(async () => {
      cross(trigger, document.body);
      vi.advanceTimersByTime(1_000);
    });
    await open();
    // Its list closed under it.
    await act(async () => {
      container.querySelector("[data-list]")?.setAttribute("inert", "");
      await Promise.resolve();
    });
    expect(dialog()?.getAttribute("data-open")).toBeNull();
  });

  it("waits, unseen, for what its content says is still loading", async () => {
    const render = (pending: boolean) =>
      root.render(
        <ResourceInspector
          label="Project details"
          content={<PendingContent pending={pending} />}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    await act(async () => render(true));
    const trigger = container.querySelector("button");
    const panel = () => document.querySelector("[data-resource-inspector]");
    await act(async () => trigger?.focus());
    // Mounted, measuring, but not seen.
    expect(panel()).not.toBeNull();
    expect(panel()?.getAttribute("data-open")).toBeNull();
    expect(panel()?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => render(false));
    expect(panel()?.getAttribute("data-open")).toBe("true");
    expect(panel()?.textContent).toBe("Loaded");
  });

  it("appears anyway once its reads take too long", async () => {
    await act(async () =>
      root.render(
        <ResourceInspector
          label="Project details"
          content={<PendingContent pending />}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      ),
    );
    await act(async () => container.querySelector("button")?.focus());
    const panel = () => document.querySelector("[data-resource-inspector]");
    expect(panel()?.getAttribute("data-open")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MAX_MS);
    });
    expect(panel()?.getAttribute("data-open")).toBe("true");
  });

  it("leaves unseen when focus moves on before it appears", async () => {
    const render = (pending: boolean) =>
      root.render(
        <ResourceInspector
          label="Project details"
          content={<PendingContent pending={pending} />}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    await act(async () => render(true));
    const trigger = container.querySelector("button");
    const panel = () => document.querySelector("[data-resource-inspector]");
    // Anything that would show the panel, even for a frame.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const node = panel();
      if (
        node?.hasAttribute("data-open") ||
        node?.className.includes("animate-inspector-")
      )
        seen.push(node.className);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    try {
      // Tabbing through a switcher: the card mounts unseen while its reads
      // load, then focus moves on.
      await act(async () => trigger?.focus());
      expect(panel()).not.toBeNull();
      await act(async () => {
        trigger?.blur();
        vi.advanceTimersByTime(130);
      });
      // Its reads land as it closes; nothing appears, and it is gone.
      await act(async () => render(false));
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(panel()).toBeNull();
      expect(seen).toEqual([]);
    } finally {
      observer.disconnect();
    }
  });

  it("leaves unseen when the pointer moves on before its reads land", async () => {
    await act(async () =>
      root.render(
        <ResourceInspector
          label="Project details"
          content={<PendingContent pending />}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      ),
    );
    const trigger = container.querySelector("button");
    const panel = () => document.querySelector("[data-resource-inspector]");
    await act(async () => {
      cross(document.body, trigger);
      vi.advanceTimersByTime(500);
    });
    expect(panel()?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      cross(trigger, document.body);
      vi.advanceTimersByTime(130);
    });
    // Gone at once, before the longest wait would have shown it.
    expect(panel()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SETTLE_MAX_MS);
    });
    expect(panel()).toBeNull();
  });

  it("sits beside the list its trigger is a row of, level with the row", async () => {
    function List() {
      const list = useRef<HTMLDivElement>(null);
      return (
        <div ref={list} data-list>
          <ResourceInspector
            label="Project details"
            content={<p>Details</p>}
            anchorRef={list}
          >
            {(props) => (
              <button type="button" {...props}>
                Project
              </button>
            )}
          </ResourceInspector>
          <button type="button">Open in another window</button>
        </div>
      );
    }
    await act(async () => root.render(<List />));
    // jsdom lays nothing out: the list spans the sidebar, the row is lower.
    const box = (left: number, top: number, right: number, bottom: number) =>
      new DOMRect(left, top, right - left, bottom - top);
    const list = container.querySelector<HTMLElement>("[data-list]");
    const trigger = container.querySelector("button");
    if (!list || !trigger) throw new Error("missing list");
    list.getBoundingClientRect = () => box(12, 80, 248, 220);
    trigger.getBoundingClientRect = () => box(17, 120, 215, 152);
    await act(async () => trigger.focus());
    const panel = document.querySelector<HTMLElement>(
      "[data-resource-inspector]",
    );
    expect(panel?.style.left).toBe("256px");
    expect(panel?.style.top).toBe("120px");
  });

  it("flips left and clamps vertically at viewport edges", () => {
    expect(
      computeInspectorPosition({
        anchor: { top: 190, right: 295, bottom: 210, left: 250 },
        width: 100,
        height: 80,
        viewportWidth: 300,
        viewportHeight: 220,
      }),
    ).toEqual({ side: "left", left: 142, top: 132 });
  });
});

it("stacks above the anchor when asked, and below only when there is no room", () => {
  // A pill preview must never land on the pill's own remove button, so it
  // sits over the pill, left-aligned, instead of beside it.
  expect(
    computeInspectorPosition({
      placement: "above",
      anchor: { top: 400, right: 260, bottom: 420, left: 200 },
      width: 320,
      height: 120,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
  ).toEqual({ side: "right", left: 200, top: 272 });
  const cramped = computeInspectorPosition({
    placement: "above",
    anchor: { top: 20, right: 260, bottom: 40, left: 200 },
    width: 320,
    height: 120,
    viewportWidth: 800,
    viewportHeight: 600,
  });
  expect(cramped.top).toBe(48);
  expect(cramped.left).toBe(200);
});

it("clamps a stale anchor after the viewport shrinks", () => {
  const position = computeInspectorPosition({
    anchor: { left: 1100, right: 1200, top: 900, bottom: 930 },
    width: 320,
    height: 250,
    viewportWidth: 600,
    viewportHeight: 500,
  });
  expect(position.left).toBe(272);
  expect(position.top).toBe(242);
});
