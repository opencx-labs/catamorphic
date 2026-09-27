// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteServiceConnectionsModal } from "./remote-service-connections-modal.js";

const formChallenge = {
  kind: "form" as const,
  fields: [
    { name: "appId", label: "App ID", secret: false, required: true },
    {
      name: "privateKey",
      label: "Private key (PEM)",
      secret: true,
      required: true,
      multiline: true,
    },
  ],
};

const desktop = vi.hoisted(() => ({
  remoteServiceConnections: vi.fn(),
  remoteServiceConnectionAuthorize: vi.fn(),
  remoteServiceConnectionComplete: vi.fn(),
  remoteServiceConnectionCreate: vi.fn(),
  remoteServiceConnectionRevoke: vi.fn(),
}));

vi.mock("../lib/desktop-api.js", () => ({ desktopApi: desktop }));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

/** Types into a React-controlled field the way a paste would. */
function typeInto(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----";

describe("RemoteServiceConnectionsModal", () => {
  it("keeps a pasted PEM key's line breaks and retries on a fresh attempt", async () => {
    desktop.remoteServiceConnections.mockResolvedValue({
      providers: [{ kind: "github", displayName: "GitHub" }],
      connections: [
        {
          id: "conn-1",
          name: "github",
          label: "github",
          providerKind: "github",
          status: "pending",
        },
      ],
    });
    desktop.remoteServiceConnectionAuthorize
      .mockResolvedValueOnce({
        authorizationId: "attempt-1",
        challenge: formChallenge,
      })
      .mockResolvedValueOnce({
        authorizationId: "attempt-2",
        challenge: formChallenge,
      });
    desktop.remoteServiceConnectionComplete
      .mockRejectedValueOnce(new Error("Authorization failed"))
      .mockResolvedValueOnce({});

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <RemoteServiceConnectionsModal
          open
          projectId="project-1"
          onClose={() => {}}
        />,
      );
    });

    const connect = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Connect",
    );
    await act(async () => connect?.click());

    const key = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[name="privateKey"]',
    );
    const appId = document.body.querySelector<HTMLInputElement>(
      'input[name="appId"]',
    );
    expect(key).not.toBeNull();
    expect(appId).not.toBeNull();
    if (!key || !appId) return;
    act(() => {
      typeInto(appId, "12345");
      typeInto(key, PEM);
    });

    const save = () =>
      Array.from(document.body.querySelectorAll("form")).at(-1);
    await act(async () => save()?.requestSubmit());

    expect(desktop.remoteServiceConnectionComplete).toHaveBeenLastCalledWith({
      projectId: "project-1",
      authorizationId: "attempt-1",
      callback: { appId: "12345", privateKey: PEM },
    });
    expect(document.body.textContent).toContain("Authorization failed");
    // The failed attempt is canceled on the server, so the dialog starts a
    // fresh one and keeps what was typed.
    expect(desktop.remoteServiceConnectionAuthorize).toHaveBeenCalledTimes(2);
    expect(key.value).toBe(PEM);

    await act(async () => save()?.requestSubmit());
    expect(desktop.remoteServiceConnectionComplete).toHaveBeenLastCalledWith({
      projectId: "project-1",
      authorizationId: "attempt-2",
      callback: { appId: "12345", privateKey: PEM },
    });
  });
});
