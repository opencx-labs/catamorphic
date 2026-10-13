// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notePagePress } from "./app-focus.js";
import { usePopoverDismiss } from "./popover-dismiss.js";

function Popover({ closeOnBlur }: { closeOnBlur?: boolean }) {
  const [open, setOpen] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  usePopoverDismiss({
    open,
    within: [root],
    onDismiss: () => setOpen(false),
    returnFocus: trigger,
    closeOnBlur,
  });
  return (
    <div ref={root} data-open={open || undefined}>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Switch
      </button>
      {open && (
        <button type="button" data-row>
          Row
        </button>
      )}
    </div>
  );
}

describe("usePopoverDismiss", () => {
  let container: HTMLDivElement;
  let outside: HTMLButtonElement;
  let root: Root;

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    outside = document.createElement("button");
    document.body.append(container, outside);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    outside.remove();
    for (const node of document.querySelectorAll(
      "[data-menu-shield], [data-resource-inspector]",
    ))
      node.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const mount = async (closeOnBlur?: boolean) => {
    await act(async () => root.render(<Popover closeOnBlur={closeOnBlur} />));
  };
  const isOpen = () => container.querySelector("[data-open]") !== null;
  const press = (target: Element) =>
    act(async () => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

  it("stays open for presses inside it and closes on a press outside", async () => {
    await mount();
    const row = container.querySelector("[data-row]");
    if (!row) throw new Error("No row");
    await press(row);
    expect(isOpen()).toBe(true);
    await press(outside);
    expect(isOpen()).toBe(false);
  });

  it("leaves presses on what it opened above itself to those", async () => {
    await mount();
    for (const attribute of ["data-menu-shield", "data-resource-inspector"]) {
      const layer = document.createElement("div");
      layer.setAttribute(attribute, "");
      document.body.append(layer);
      await press(layer);
      expect(isOpen()).toBe(true);
    }
  });

  it("closes on a press inside a web page, which the window never sees", async () => {
    await mount();
    await act(async () => notePagePress());
    expect(isOpen()).toBe(false);
  });

  it("closes when the window loses focus, unless told otherwise", async () => {
    await mount();
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(isOpen()).toBe(false);
    await act(async () => root.render(null));
    await mount(false);
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(isOpen()).toBe(true);
  });

  it("closes on Escape, giving focus back to its trigger, after anything above it", async () => {
    await mount();
    const row = container.querySelector<HTMLButtonElement>("[data-row]");
    row?.focus();
    // A menu or card above it claims Escape first.
    const claimed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    await act(async () => row?.dispatchEvent(claimed));
    expect(isOpen()).toBe(true);
    const unclaimed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => row?.dispatchEvent(unclaimed));
    expect(isOpen()).toBe(false);
    // Claimed from window listeners such as the expanded chat's.
    expect(unclaimed.defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe("Switch");
  });
});
