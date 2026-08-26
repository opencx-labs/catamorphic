// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { RemoteConnectionIndicator } from "./remote-connection-indicator.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    remoteStatus: vi.fn(),
    remoteReconnect: vi.fn(),
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("RemoteConnectionIndicator", () => {
  it("shows sign-in-required status and reconnects on click", async () => {
    vi.mocked(desktopApi.remoteStatus).mockResolvedValue({
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "remote-1",
      remoteProjectName: "Acme Brain",
      lastSyncAt: null,
      connection: {
        state: "sign_in_required",
        checkedAt: "2026-08-26T00:00:00.000Z",
        message: "Sign in again to reconnect this project.",
      },
      local: { modified: [], deleted: [], programEdits: [] },
    });
    vi.mocked(desktopApi.remoteReconnect).mockResolvedValue({ ok: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<RemoteConnectionIndicator projectId="local-1" />);
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-connection-status"]',
    );
    expect(button?.getAttribute("aria-label")).toContain("Sign in again");
    await act(async () => button?.click());
    expect(desktopApi.remoteReconnect).toHaveBeenCalledWith("local-1");
  });
});
