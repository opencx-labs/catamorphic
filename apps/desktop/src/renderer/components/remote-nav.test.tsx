// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { RemoteNav } from "./remote-nav.js";

vi.mock("./remote-members-modal.js", () => ({
  RemoteMembersModal: () => null,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    remoteStatus: vi.fn(async () => ({
      serverUrl: "https://example.com",
      connection: { state: "connected" },
      lastSyncAt: null,
      local: {
        modified: ["store/report.md", "store/private.md"],
        deleted: [],
        programEdits: [],
        conflicts: [],
      },
    })),
    onGitChanged: vi.fn(() => () => {}),
    remoteShip: vi.fn(async () => ({
      shipped: ["store/report.md"],
      deleted: [],
      conflicts: [],
      failed: [],
      notShippable: [],
    })),
  },
}));

it("starts with no upload selection and sends only the chosen document", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RemoteNav
          projectId="project"
          onOpenFile={() => {}}
          onOpenHistory={() => {}}
          onPublish={() => {}}
          onPropose={() => {}}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-ship"]',
    );
    expect(button?.disabled).toBe(true);
    const checkbox = container.querySelector<HTMLInputElement>(
      '[aria-label="Upload report.md"]',
    );
    await act(async () => checkbox?.click());
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(desktopApi.remoteShip).toHaveBeenCalledWith({
      projectId: "project",
      paths: ["store/report.md"],
      resolveConflicts: [],
    });
    expect(button?.disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  }
});
