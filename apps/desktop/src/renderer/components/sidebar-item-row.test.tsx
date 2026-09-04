// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarItemRow } from "./sidebar-item-row.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

function mountRow() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <SidebarItemRow
        label="Deployments"
        preview={{
          title: "Production deployments",
          description: "Release health at a glance",
          metadata: [
            { label: "Owner", value: "Platform" },
            { label: "Status", value: "Healthy" },
          ],
        }}
        onOpen={() => {}}
        onAction={() => {}}
      />,
    );
  });
  return container;
}

function mountMenuRow(onAction = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <SidebarItemRow
        label="Chat"
        menu={[
          { label: "Mark as unread", action: "mark-unread" },
          { label: "Archive", action: "archive" },
        ]}
        onOpen={() => {}}
        onAction={onAction}
      />,
    );
  });
  return { container, onAction };
}

describe("SidebarItemRow hover preview", () => {
  it("shows configured preview content only after the dwell delay", () => {
    vi.useFakeTimers();
    const container = mountRow();
    const row = container.firstElementChild as HTMLElement;

    act(() =>
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(499));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const preview = document.querySelector('[role="tooltip"]');
    expect(preview?.textContent).toContain("Production deployments");
    expect(preview?.textContent).toContain("Release health at a glance");
    expect(preview?.textContent).toContain("Owner");
    expect(preview?.textContent).toContain("Platform");
    expect(preview?.textContent).toContain("Status");
    expect(preview?.textContent).toContain("Healthy");
  });

  it("offers the same preview when the row receives keyboard focus", () => {
    vi.useFakeTimers();
    const container = mountRow();
    const button = container.querySelector("button");

    act(() => button?.focus());
    act(() => vi.advanceTimersByTime(500));

    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "Production deployments",
    );
  });

  it("keeps the preview open while the pointer moves onto the card", () => {
    vi.useFakeTimers();
    const container = mountRow();
    const row = container.firstElementChild as HTMLElement;

    act(() =>
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(500));
    const preview = document.querySelector('[role="tooltip"]');
    expect(preview).not.toBeNull();

    act(() => {
      row.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      preview?.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      vi.advanceTimersByTime(200);
    });

    expect(preview?.classList.contains("animate-pop-in")).toBe(true);
  });

  it("dismisses a focused preview when Escape is pressed", () => {
    vi.useFakeTimers();
    const container = mountRow();
    const button = container.querySelector("button");

    act(() => button?.focus());
    act(() => vi.advanceTimersByTime(500));
    const preview = document.querySelector('[role="tooltip"]');
    expect(preview?.classList.contains("animate-pop-in")).toBe(true);

    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );

    expect(preview?.classList.contains("animate-pop-out")).toBe(true);
  });
});

describe("SidebarItemRow menu motion", () => {
  it("focuses the animated entrance and stays mounted through exit", () => {
    vi.useFakeTimers();
    const { container } = mountMenuRow();
    const row = container.firstElementChild;
    if (!(row instanceof HTMLElement)) throw new Error("row did not mount");

    act(() => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 200,
          clientY: 200,
        }),
      );
    });

    const menu = document.querySelector('[role="menu"]');
    if (!(menu instanceof HTMLElement)) throw new Error("menu did not open");
    const panel = menu.firstElementChild;
    if (!(panel instanceof HTMLElement)) throw new Error("menu panel missing");
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    expect(panel.classList).toContain("animate-pop-in");
    expect(document.activeElement).toBe(buttons[0]);

    act(() => {
      buttons[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[1]);

    act(() => window.dispatchEvent(new Event("pointerdown")));
    expect(document.querySelector('[role="menu"]')).toBe(menu);
    expect(panel.classList).toContain("animate-pop-out");

    act(() => vi.advanceTimersByTime(180));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("applies a selected action only after its exit finishes", () => {
    vi.useFakeTimers();
    const { container, onAction } = mountMenuRow();
    const row = container.firstElementChild;
    if (!(row instanceof HTMLElement)) throw new Error("row did not mount");

    act(() => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 200 }),
      );
    });
    const archive = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Archive");
    if (!archive) throw new Error("archive action missing");

    act(() => archive.click());
    expect(onAction).not.toHaveBeenCalled();
    expect(
      document.querySelector('[role="menu"]')?.firstElementChild?.classList,
    ).toContain("animate-pop-out");

    act(() => vi.advanceTimersByTime(180));
    expect(onAction).toHaveBeenCalledWith({
      label: "Archive",
      action: "archive",
    });
  });
});
