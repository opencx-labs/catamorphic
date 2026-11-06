// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionModeFields } from "./agent-permission-fields.js";

describe("PermissionModeFields (ADR 0182)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const choose = async (select: HTMLSelectElement | null, value: string) => {
    if (!select) throw new Error("No select");
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("names Claude Code's permission modes as Claude Code does", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <PermissionModeFields
          harness="claude-code"
          value={{ permissionMode: "bypassPermissions" }}
          onChange={onChange}
        />,
      );
    });
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-permission-mode"]',
    );
    expect(container.textContent).toContain("Permission mode");
    expect([...(select?.options ?? [])].map((option) => option.text)).toEqual([
      "Default",
      "Accept edits",
      "Plan",
      "Auto",
      "Don't ask",
      "Bypass permissions",
    ]);
    await choose(select, "dontAsk");
    expect(onChange).toHaveBeenCalledWith({ permissionMode: "dontAsk" });
  });

  it("gives Codex its sandbox and approvals", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <PermissionModeFields
          harness="codex"
          value={{ sandbox: "danger-full-access", approvals: "on-request" }}
          onChange={onChange}
        />,
      );
    });
    expect(container.textContent).toContain("Codex sandbox");
    expect(container.textContent).toContain("Approvals");
    await choose(
      container.querySelector('[data-testid="agent-codex-sandbox"]'),
      "workspace-write",
    );
    expect(onChange).toHaveBeenLastCalledWith({
      sandbox: "workspace-write",
      approvals: "on-request",
    });
    await choose(
      container.querySelector('[data-testid="agent-codex-approvals"]'),
      "untrusted",
    );
    expect(onChange).toHaveBeenLastCalledWith({
      sandbox: "danger-full-access",
      approvals: "untrusted",
    });
  });

  it("shows nothing for the built-in agent", async () => {
    await act(async () => {
      root.render(
        <PermissionModeFields harness="ai-sdk" value={{}} onChange={vi.fn()} />,
      );
    });
    expect(container.textContent).toBe("");
  });
});
