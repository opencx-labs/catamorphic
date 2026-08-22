// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "./modal.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const containers: HTMLElement[] = [];
const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

function mountModal(onClose: () => void) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (revision: number) => {
    act(() => {
      root.render(
        <Modal open onClose={() => onClose()}>
          <p>{revision}</p>
          <button type="button">First</button>
          <button type="button">Last</button>
        </Modal>,
      );
    });
  };
  render(0);
  return { container, render };
}

function mountControlledModal(opener: HTMLElement) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (open: boolean) => {
    act(() => {
      root.render(
        <Modal open={open} onClose={() => {}}>
          <button type="button">Inside</button>
        </Modal>,
      );
    });
  };
  opener.focus();
  render(true);
  return { render };
}

describe("Modal focus containment", () => {
  it("does not reset focused controls when a parent rerenders", () => {
    const { container, render } = mountModal(() => {});
    const first = container.querySelector<HTMLButtonElement>("button");
    first?.focus();

    render(1);

    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the initially focused panel to the last control", () => {
    const { container } = mountModal(() => {});
    const panel = container.querySelector<HTMLElement>('[role="dialog"]');
    const controls = container.querySelectorAll<HTMLButtonElement>("button");
    expect(document.activeElement).toBe(panel);

    act(() => {
      panel?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(document.activeElement).toBe(controls.item(1));
  });

  it("does not steal focus from a newer surface when it closes", () => {
    const opener = document.createElement("button");
    const newerControl = document.createElement("textarea");
    document.body.append(opener, newerControl);
    containers.push(opener, newerControl);
    const { render } = mountControlledModal(opener);
    newerControl.focus();

    render(false);

    expect(document.activeElement).toBe(newerControl);
  });
});
