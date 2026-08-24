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
});
