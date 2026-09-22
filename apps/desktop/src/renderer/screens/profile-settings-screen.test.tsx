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
    vaultList: vi.fn().mockResolvedValue([]),
    vaultReveal: vi.fn().mockResolvedValue(null),
    vaultSave: vi.fn().mockResolvedValue(undefined),
    vaultUpdate: vi.fn().mockResolvedValue(undefined),
    vaultRemove: vi.fn().mockResolvedValue(undefined),
    vaultCopyPassword: vi.fn().mockResolvedValue(true),
    onVaultChanged: vi.fn().mockReturnValue(() => undefined),

    browserImportList: vi.fn().mockResolvedValue([]),
    browserImportRun: vi.fn().mockResolvedValue({ cancelled: false }),
    browserImportPasswords: vi
      .fn()
      .mockResolvedValue({ imported: 0, cancelled: true }),
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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        readonly m42 = 0;
      },
    );
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("owns vertical scrolling inside its workspace pane", async () => {
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

    const screen = container.querySelector(
      '[data-testid="profile-settings-screen"]',
    );
    expect(screen?.classList.contains("h-full")).toBe(true);
    expect(screen?.classList.contains("min-h-0")).toBe(true);
    expect(screen?.classList.contains("overflow-y-auto")).toBe(true);
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

  it("counts saved logins and opens the profile's Passwords page", async () => {
    vi.mocked(desktopApi.vaultList).mockResolvedValueOnce([
      {
        id: "credential-1",
        origin: "https://accounts.example.com",
        username: "alice@example.com",
        hasNote: false,
        updatedAt: 0,
      },
    ]);
    const onOpenPasswords = vi.fn();
    await act(async () => {
      root.render(
        <ProfileSettingsScreen
          profileId={profile.id}
          activeProfileId={profile.id}
          data={{ profiles: [profile], defaultProfileId: profile.id }}
          projects={[project]}
          onClose={() => undefined}
          onOpenPasswords={onOpenPasswords}
        />,
      );
    });
    expect(container.textContent).toContain("1 saved login");
    const open = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open passwords"),
    );
    await act(async () => open?.click());
    expect(onOpenPasswords).toHaveBeenCalledOnce();
  });
});
