// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileBar } from "./profile-bar";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    profilesCreate: vi.fn(),
    profileConnections: vi.fn(async () => []),
  },
}));

describe("ProfileBar", () => {
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
    document.querySelectorAll("[data-resource-inspector]").forEach((node) => {
      node.remove();
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("uses passive current/default markers and no inline edit action", async () => {
    await act(async () => {
      root.render(
        <ProfileBar
          data={{
            defaultProfileId: "profile-1",
            profiles: [
              {
                id: "profile-1",
                name: "Default Profile",
                color: "#8b5cf6",
                projectIds: ["project-1"],
                defaultProjectId: "project-1",
              },
            ],
          }}
          activeProfileId="profile-1"
          onSwitch={() => undefined}
          onOpenSettings={() => undefined}
        />,
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')
        ?.click(),
    );
    expect(container.querySelector('[aria-label^="Rename"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Default profile"]'),
    ).not.toBeNull();
    expect(container.querySelector('svg[class*="text-accent"]')).not.toBeNull();
  });

  it("previews the active profile on focus, and gives way to its menu", async () => {
    await act(async () => {
      root.render(
        <ProfileBar
          data={{
            defaultProfileId: "profile-1",
            profiles: [
              {
                id: "profile-1",
                name: "Default Profile",
                color: "#8b5cf6",
                projectIds: ["project-1"],
                defaultProjectId: "project-1",
              },
            ],
          }}
          activeProfileId="profile-1"
          onSwitch={() => undefined}
          onOpenSettings={() => undefined}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Switch profile"]',
    );
    const preview = () =>
      document.querySelector(
        '[aria-label="Default Profile profile details"][data-open="true"]',
      );
    await act(async () => trigger?.focus());
    expect(preview()).not.toBeNull();
    expect(trigger?.getAttribute("aria-details")).toBe(preview()?.id);

    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(preview()).toBeNull();
    await act(async () => {
      trigger?.blur();
      trigger?.focus();
    });
    expect(preview()).toBeNull();
  });

  it("takes focus into its dialog as it opens and gives it back as it closes", async () => {
    const data = {
      defaultProfileId: "profile-1",
      profiles: [
        {
          id: "profile-1",
          name: "Default Profile",
          color: "#8b5cf6",
          projectIds: ["project-1"],
          defaultProjectId: "project-1",
        },
        {
          id: "profile-2",
          name: "Work",
          color: "#22c55e",
          projectIds: [],
        },
      ],
    };
    await act(async () => {
      root.render(
        <ProfileBar
          data={data}
          activeProfileId="profile-2"
          onSwitch={() => undefined}
          onOpenSettings={() => undefined}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Switch profile"]',
    );
    const preview = () =>
      document.querySelector("[data-resource-inspector][data-open]");
    await act(async () => {
      trigger?.focus();
      trigger?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    // On the profile in use, without opening its preview.
    expect(document.activeElement?.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement?.textContent).toContain("Work");
    expect(preview()).toBeNull();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(preview()).toBeNull();
    // Closed by picking a profile, focus goes back to the control too.
    await act(async () => {
      trigger?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await act(async () =>
      (document.activeElement as HTMLButtonElement | null)?.click(),
    );
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
