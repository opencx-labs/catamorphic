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
    profilesSyncSettings: vi.fn().mockResolvedValue(undefined),
    profilesStopSyncing: vi.fn().mockResolvedValue(undefined),
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
  remoteOwnership: null,
  remoteDivergedAt: null,
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

  it("imports settings from another profile, kept in sync or copied", async () => {
    const personal = {
      id: "profile-2",
      name: "Personal",
      color: "#3b82f6",
      projectIds: [],
    };
    await act(async () => {
      root.render(
        <ProfileSettingsScreen
          profileId={personal.id}
          activeProfileId={profile.id}
          data={{ profiles: [profile, personal], defaultProfileId: profile.id }}
          projects={[project]}
          onClose={() => undefined}
        />,
      );
    });
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-profile-import"]',
    );
    expect(open?.disabled).toBe(false);
    await act(async () => open?.click());
    const dialog = document.querySelector(
      '[data-testid="profile-import-dialog"]',
    );
    expect(dialog?.textContent).toContain(
      "Bring another profile's settings into Personal.",
    );
    const source = dialog?.querySelector<HTMLSelectElement>(
      '[aria-label="Import from profile"]',
    );
    expect(source?.value).toBe(profile.id);
    const macros = dialog?.querySelector<HTMLInputElement>(
      '[data-sync-part="macros"]',
    );
    await act(async () => macros?.click());
    const start = dialog?.querySelector<HTMLButtonElement>(
      '[data-testid="profile-import-start"]',
    );
    await act(async () => start?.click());
    expect(desktopApi.profilesSyncSettings).toHaveBeenCalledWith({
      profileId: personal.id,
      from: profile.id,
      parts: ["appearance", "workspace", "shortcuts", "notifications"],
      keepInSync: true,
    });
  });

  it("lists what stays in sync and stops it from either profile", async () => {
    const personal = {
      id: "profile-2",
      name: "Personal",
      color: "#3b82f6",
      projectIds: [],
      syncedFrom: { appearance: profile.id, shortcuts: profile.id },
    };
    const data = {
      profiles: [profile, personal],
      defaultProfileId: profile.id,
    };
    await act(async () => {
      root.render(
        <ProfileSettingsScreen
          profileId={profile.id}
          activeProfileId={profile.id}
          data={data}
          projects={[project]}
          onClose={() => undefined}
        />,
      );
    });
    const row = container.querySelector(`[data-sync-partner="${personal.id}"]`);
    expect(row?.textContent).toContain("Personal");
    expect(row?.textContent).toContain(
      "Appearance and Keyboard shortcuts, kept in sync",
    );
    const stop = [...(row?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Stop syncing"),
    );
    await act(async () => stop?.click());
    // The follower takes a copy, even when stopped from the owner's side.
    expect(desktopApi.profilesStopSyncing).toHaveBeenCalledWith({
      profileId: personal.id,
      parts: ["appearance", "shortcuts"],
    });
  });
});
