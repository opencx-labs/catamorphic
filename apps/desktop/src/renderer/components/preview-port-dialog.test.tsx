// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatSessionMenu } from "../lib/chat-session-actions.js";
import {
  lastPreviewPort,
  rememberPreviewPort,
} from "../lib/remote-workspace.js";
import {
  PreviewPortDialog,
  type PreviewPortRequest,
} from "./preview-port-dialog.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  localStorage.clear();
});

function mount(input: {
  request: PreviewPortRequest | null;
  error?: string | null;
  onOpen?: (port: number) => void;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <PreviewPortDialog
        request={input.request}
        pending={false}
        error={input.error ?? null}
        onClose={() => {}}
        onOpen={input.onOpen ?? (() => {})}
      />,
    );
  });
}

const portInput = () =>
  document.body.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
const openButton = () =>
  document.body.querySelector<HTMLButtonElement>('button[type="submit"]');

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(portInput(), value);
    portInput()?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Open preview (ADR 0209)", () => {
  it("offers the chat's last port and opens what is entered", () => {
    const onOpen = vi.fn();
    mount({
      request: { sessionId: "s", chatTitle: "Fix login", lastPort: 5173 },
      onOpen,
    });
    expect(document.body.textContent).toContain("Fix login");
    expect(portInput()?.value).toBe("5173");
    type("3000");
    act(() => openButton()?.click());
    expect(onOpen).toHaveBeenCalledWith(3000);
  });

  it("opens nothing for a port outside 1 to 65535", () => {
    const onOpen = vi.fn();
    mount({ request: { sessionId: "s", chatTitle: "Chat" }, onOpen });
    expect(portInput()?.value).toBe("");
    type("70000");
    expect(openButton()?.disabled).toBe(true);
    expect(openButton()?.dataset.disabledReason).toBe(
      "Enter a port from 1 to 65535",
    );
    expect(document.body.textContent).toContain(
      "A port is a number from 1 to 65535.",
    );
    // The hint describes the field to assistive technology.
    const hintId = portInput()?.getAttribute("aria-describedby");
    expect(hintId ? document.getElementById(hintId)?.textContent : null).toBe(
      "A port is a number from 1 to 65535.",
    );
    act(() => openButton()?.click());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says why opening failed", () => {
    mount({
      request: { sessionId: "s", chatTitle: "Chat", lastPort: 3000 },
      error:
        "This chat's workspace is not running; send it a message to start it.",
    });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "This chat's workspace is not running; send it a message to start it.",
    );
  });

  it("remembers the last port per chat", () => {
    expect(lastPreviewPort("a")).toBeUndefined();
    rememberPreviewPort("a", 5173);
    rememberPreviewPort("b", 8080);
    rememberPreviewPort("a", 3000);
    expect(lastPreviewPort("a")).toBe(3000);
    expect(lastPreviewPort("b")).toBe(8080);
    localStorage.setItem("work.previewPorts", "not json");
    expect(lastPreviewPort("a")).toBeUndefined();
  });
});

describe("chat menu", () => {
  it("offers a terminal and a preview for a remote chat only", () => {
    const actions = (remote: boolean, archived = false) =>
      chatSessionMenu({ unread: false, archived, remote }).map(
        (entry) => entry.action,
      );
    expect(actions(true)).toEqual([
      "new-subsession",
      "open-terminal",
      "open-preview",
      "mark-unread",
      "archive",
    ]);
    expect(actions(false)).not.toContain("open-terminal");
    expect(actions(true, true)).not.toContain("open-preview");
  });
});
