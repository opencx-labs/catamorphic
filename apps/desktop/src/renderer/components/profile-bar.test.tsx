// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileBar } from "./profile-bar";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { profilesCreate: vi.fn() },
}));

const projects = [
  {
    id: "project-1",
    name: "Alpha",
    storageType: "managed" as const,
    remoteUrl: null,
    defaultBranch: "main",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
];

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
          projects={projects}
          activeProfileId="profile-1"
          onSwitch={() => undefined}
          onOpenSettings={() => undefined}
        />,
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
        ?.click(),
    );
    expect(container.querySelector('[aria-label^="Rename"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Default profile"]'),
    ).not.toBeNull();
    expect(container.querySelector('svg[class*="text-accent"]')).not.toBeNull();
  });
});
