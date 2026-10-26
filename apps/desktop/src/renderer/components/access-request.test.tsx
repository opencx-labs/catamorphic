// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAccessRequest } from "../../shared/code-access.js";
import { SidebarStatusBody } from "./sidebar-status.js";

const request: ModuleAccessRequest = {
  module: ".work/todos.ts",
  beyond: ["Reach api.linear.app"],
  all: ["Read and act on your open tabs", "Reach api.linear.app"],
  network: true,
  fingerprint: '[["hosts",["api.linear.app"]],["lists",["tabs"]]]',
};

describe("a module's request (ADR 0277)", () => {
  let node: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });
  afterEach(() => {
    act(() => root.unmount());
    node.remove();
  });

  it("names only what is new, says files could leave, and allows", async () => {
    const allow = vi.fn(async () => {});
    await act(async () =>
      root.render(
        <SidebarStatusBody
          status={{ state: "access", access: { request, allow } }}
        />,
      ),
    );
    const asked = node.querySelector('[data-testid="module-access-request"]');
    expect(asked?.getAttribute("aria-label")).toBe(
      ".work/todos.ts wants more access",
    );
    expect(asked?.textContent).toContain(".work/todos.ts now also wants to");
    expect(
      [...(asked?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual(["Reach api.linear.app"]);
    expect(asked?.textContent).toContain(
      "Already allowed: Read and act on your open tabs.",
    );
    expect(asked?.textContent).toContain(
      "It can read this project's files and send them to these addresses.",
    );
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>('[data-testid="module-access-allow"]')
        ?.click(),
    );
    expect(allow).toHaveBeenCalledOnce();
  });

  it("says why allowing failed", async () => {
    const allow = vi.fn(async () => {
      throw new Error(
        "This module's access changed while you looked at it. Check it again.",
      );
    });
    await act(async () =>
      root.render(
        <SidebarStatusBody
          status={{
            state: "access",
            access: {
              request: { ...request, network: false, all: request.beyond },
              allow,
            },
          }}
        />,
      ),
    );
    expect(node.textContent).toContain(".work/todos.ts wants to");
    expect(node.textContent).not.toContain("send them");
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>('[data-testid="module-access-allow"]')
        ?.click(),
    );
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "changed while you looked",
    );
  });
});
