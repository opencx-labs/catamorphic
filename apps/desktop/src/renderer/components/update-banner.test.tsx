// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateState } from "../lib/desktop-api.js";
import { desktopApi } from "../lib/desktop-api.js";
import { UpdateBanner } from "./update-banner.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    updateState: vi.fn(),
    updateDownload: vi.fn(),
    updateInstall: vi.fn(),
    updateCheck: vi.fn(),
    onUpdateStateChanged: vi.fn(() => () => {}),
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

async function mount(state: DesktopUpdateState, hasActiveWork = false) {
  vi.mocked(desktopApi.updateState).mockResolvedValue(state);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <UpdateBanner hasActiveWork={hasActiveWork} onOpenRelease={() => {}} />,
    );
  });
  return container;
}

describe("UpdateBanner", () => {
  it("offers an explicit download for an available update", async () => {
    const container = await mount({
      phase: "available",
      currentVersion: "0.1.0-alpha.1",
      manual: true,
      version: "0.1.0-alpha.2",
      releaseUrl:
        "https://github.com/opencx-labs/catamorphic/releases/tag/desktop-v0.1.0-alpha.2",
    });

    expect(container.textContent).toContain(
      "Catamorphic 0.1.0-alpha.2 is available",
    );
    const download = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Download update",
    );
    act(() => download?.click());
    expect(desktopApi.updateDownload).toHaveBeenCalledOnce();
  });

  it("holds restart while agents or terminals are active", async () => {
    const container = await mount(
      {
        phase: "downloaded",
        currentVersion: "0.1.0-alpha.1",
        manual: true,
        version: "0.1.0-alpha.2",
      },
      true,
    );

    expect(container.textContent).toContain(
      "Finish active agents and terminals before restarting.",
    );
    const restart = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Restart to update",
    );
    expect(restart?.disabled).toBe(true);
  });
});
