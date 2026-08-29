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
    browserImportRun: vi
      .fn()
      .mockResolvedValue({ bookmarksImported: 0, profilesCreated: [] }),
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

  it("opens password management from profile settings", async () => {
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
    const add = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add password"),
    );
    await act(async () => add?.click());
    const editor = container.querySelector('[data-testid="password-editor"]');
    expect(editor).not.toBeNull();
    expect(
      editor?.querySelector('[data-testid="password-origin"]'),
    ).not.toBeNull();
    expect(
      editor?.querySelector('[data-testid="password-username"]'),
    ).not.toBeNull();
    expect(
      editor?.querySelector('[data-testid="password-value"]'),
    ).not.toBeNull();
    expect(
      editor?.parentElement?.parentElement?.getAttribute("aria-hidden"),
    ).toBe("false");
    expect(desktopApi.vaultList).toHaveBeenCalledWith({
      profileId: profile.id,
    });
    const cancel = [...(editor?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    expect(
      editor?.parentElement?.parentElement?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(document.activeElement).toBe(add);
  });

  it("searches passwords by website and username, with every term required", async () => {
    vi.mocked(desktopApi.vaultList).mockResolvedValueOnce([
      {
        id: "credential-1",
        origin: "https://accounts.example.com",
        username: "alice@example.com",
      },
      {
        id: "credential-2",
        origin: "https://github.com",
        username: "octocat",
      },
    ]);
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
    expect(container.querySelectorAll("[data-item-id]")).toHaveLength(2);
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="password-search"]',
    );
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(search, "example alice");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll("[data-item-id]")).toHaveLength(1);
    expect(container.textContent).toContain("accounts.example.com");
    expect(container.textContent).not.toContain("octocat");
    expect(container.textContent).toContain("1 match");

    await act(async () => {
      search?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(search?.value).toBe("");
    expect(container.querySelectorAll("[data-item-id]")).toHaveLength(2);
  });

  it("reveals, copies, and confirms deletion with website-specific feedback", async () => {
    vi.mocked(desktopApi.vaultList).mockResolvedValueOnce([
      {
        id: "credential-1",
        origin: "https://accounts.example.com",
        username: "alice@example.com",
      },
    ]);
    vi.mocked(desktopApi.vaultReveal).mockResolvedValueOnce({
      id: "credential-1",
      origin: "https://accounts.example.com",
      username: "alice@example.com",
      password: "correct horse battery staple",
    });
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

    const reveal = container.querySelector<HTMLButtonElement>(
      '[aria-label="Reveal password for accounts.example.com"]',
    );
    await act(async () => reveal?.click());
    expect(container.textContent).toContain("correct horse battery staple");
    expect(desktopApi.vaultReveal).toHaveBeenCalledWith({
      profileId: profile.id,
      id: "credential-1",
    });

    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy password for accounts.example.com"]',
    );
    await act(async () => copy?.click());
    expect(
      container.querySelector(
        '[aria-label="Password for accounts.example.com copied"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "The clipboard will clear in 30 seconds.",
    );

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete password for accounts.example.com"]',
    );
    await act(async () => deleteButton?.click());
    expect(container.textContent).toContain(
      "Delete the password for accounts.example.com?",
    );
  });
});
