// @vitest-environment jsdom

import { act, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SurfaceErrorBoundary, SurfacePane } from "./surface-error-boundary.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const caught = vi.fn();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = createRoot(container, { onCaughtError: caught });
  roots.push(root);
  return { root, container, caught, log };
}

function CrashingView({ fail }: { fail: boolean }) {
  if (fail) throw new Error("surface render failure");
  return <p>Recovered content</p>;
}

it("isolates a failed pane, preserves a sibling's draft, and retries only the failed view", () => {
  const { root, container, caught, log } = setup();
  const siblingMount = vi.fn();
  const dismiss = vi.fn();
  function HealthyView() {
    useEffect(siblingMount, []);
    return <textarea aria-label="Draft" defaultValue="unsaved draft" />;
  }
  const render = (fail: boolean) =>
    act(() =>
      root.render(
        <>
          <SurfacePane
            label="Notes"
            onDismiss={dismiss}
            data-surface-key="notes"
          >
            <HealthyView />
          </SurfacePane>
          <SurfacePane
            label="New Tab"
            onDismiss={dismiss}
            data-surface-key="new"
          >
            <CrashingView fail={fail} />
          </SurfacePane>
        </>,
      ),
    );
  render(false);
  const draft = container.querySelector("textarea");
  if (!draft) throw new Error("Missing draft");
  draft.value = "keep these unsaved edits";
  render(true);
  expect(container.querySelectorAll("[data-surface-error]")).toHaveLength(1);
  expect(
    container.querySelector('[data-surface-key="new"]')?.textContent,
  ).toContain("New Tab could not be displayed");
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("keep these unsaved edits");
  expect(siblingMount).toHaveBeenCalledTimes(1);
  expect(caught).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    "[Work] Could not render New Tab",
    expect.objectContaining({ message: "surface render failure" }),
    expect.stringContaining("CrashingView"),
  );
  render(false);
  expect(container.querySelector("[data-surface-error]")).not.toBeNull();
  act(() =>
    container
      .querySelector<HTMLButtonElement>("[data-surface-error] button")
      ?.click(),
  );
  expect(container.textContent).toContain("Recovered content");
  expect(container.querySelector("[data-surface-error]")).toBeNull();
  expect(container.querySelector("textarea")).toBe(draft);
  expect(dismiss).not.toHaveBeenCalled();
});

it("resets a failed surface when its recovery key changes without remounting healthy content", () => {
  const { root, container } = setup();
  const mounted = vi.fn();
  function View({ fail }: { fail: boolean }) {
    useEffect(mounted, []);
    return <CrashingView fail={fail} />;
  }
  const render = (resetKey: string, fail: boolean) =>
    act(() =>
      root.render(
        <SurfaceErrorBoundary label="Palette" resetKey={resetKey}>
          <View fail={fail} />
        </SurfaceErrorBoundary>,
      ),
    );
  render("first", false);
  render("second", false);
  expect(mounted).toHaveBeenCalledTimes(1);
  render("second", true);
  render("second", false);
  expect(container.querySelector("[data-surface-error]")).not.toBeNull();
  render("third", false);
  expect(container.querySelector("[data-surface-error]")).toBeNull();
  expect(mounted).toHaveBeenCalledTimes(2);
});

it("contains lifecycle failures from portalled content and keeps its close action usable", () => {
  const { root, container, caught } = setup();
  const dismiss = vi.fn();
  function PortalView() {
    useLayoutEffect(() => {
      throw new Error("surface lifecycle failure");
    }, []);
    return createPortal(<p>Portal content</p>, document.body);
  }
  act(() =>
    root.render(
      <SurfaceErrorBoundary label="Chat" onDismiss={dismiss}>
        <PortalView />
      </SurfaceErrorBoundary>,
    ),
  );
  expect(caught).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("Portal content");
  act(() =>
    container.querySelectorAll<HTMLButtonElement>("button")[1]?.click(),
  );
  expect(dismiss).toHaveBeenCalledTimes(1);
});
