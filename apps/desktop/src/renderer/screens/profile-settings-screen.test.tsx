// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api";
import { ProfileSettingsScreen } from "./profile-settings-screen";

vi.mock("../lib/desktop-api", () => ({
  desktopApi: {
    profilesUpdate: vi.fn().mockResolvedValue(undefined),
    profilesSetDefault: vi.fn().mockResolvedValue(undefined),
    profilesRemove: vi.fn().mockResolvedValue(true),
  },
}));

const profile = {
  id: "profile-1",
  name: "Default Profile",
  color: "#8b5cf6",
  projectIds: ["project-1"],
  defaultProjectId: "project-1",
};
const project = {
  id: "project-1",
  name: "Alpha",
  storageType: "managed" as const,
  remoteUrl: null,
  defaultBranch: "main",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

describe("ProfileSettingsScreen", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("edits profile details and guards the final profile from deletion", async () => {
    await act(async () => {
      root.render(
        <ProfileSettingsScreen
          profileId={profile.id}
          activeProfileId={profile.id}
          data={{ profiles: [profile], defaultProfileId: profile.id }}
          projects={[project]}
          onClose={() => undefined}
        />,
      );
    });
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Profile name"]',
    );
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(input, "Work Profile");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save =
      input?.parentElement?.querySelector<HTMLButtonElement>("button");
    await act(async () => save?.click());
    expect(desktopApi.profilesUpdate).toHaveBeenCalledWith(profile.id, {
      name: "Work Profile",
    });
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Delete profile"),
    );
    expect(deleteButton?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "The last profile cannot be removed.",
    );
  });

  it("renders a recoverable state when the profile disappears", async () => {
    await act(async () => {
      root.render(
        <ProfileSettingsScreen
          profileId="missing"
          activeProfileId={profile.id}
          data={{ profiles: [profile], defaultProfileId: profile.id }}
          projects={[project]}
          onClose={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain("Profile not found");
  });
});
