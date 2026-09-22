// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api";
import { PasswordsScreen } from "./passwords-screen";

vi.mock("../lib/desktop-api", () => ({
  desktopApi: {
    vaultList: vi.fn().mockResolvedValue([]),
    vaultNeverSaved: vi.fn().mockResolvedValue([]),
    vaultAllowSaving: vi.fn().mockResolvedValue(undefined),
    vaultReveal: vi.fn().mockResolvedValue(null),
    vaultSave: vi.fn().mockResolvedValue(undefined),
    vaultUpdate: vi.fn().mockResolvedValue(undefined),
    vaultRemove: vi.fn().mockResolvedValue(undefined),
    vaultCopyPassword: vi.fn().mockResolvedValue(true),
    vaultGeneratePassword: vi.fn().mockResolvedValue("Gen3rated-Pass.x"),
    onVaultChanged: vi.fn().mockReturnValue(() => undefined),
  },
}));

const alice = {
  id: "credential-1",
  origin: "https://accounts.example.com",
  username: "alice@example.com",
  hasNote: true,
  updatedAt: Date.now(),
};
const bob = {
  id: "credential-2",
  origin: "https://mail.example.org",
  username: "bob",
  hasNote: false,
  updatedAt: Date.now(),
};

const setValue = (
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element?.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("PasswordsScreen", () => {
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

  const render = async () => {
    await act(async () => {
      root.render(<PasswordsScreen profileId="profile-1" />);
    });
  };

  it("adds a password with a generated secret and a note", async () => {
    await render();
    expect(container.textContent).toContain(
      "Passwords you save while signing in appear here.",
    );
    const add = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add"),
    );
    await act(async () => add?.click());
    const editor = document.querySelector('[data-testid="password-editor"]');
    expect(editor).not.toBeNull();
    await act(async () => {
      setValue(
        editor?.querySelector('[data-testid="password-origin"]') ?? null,
        "https://accounts.example.com",
      );
      setValue(
        editor?.querySelector('[data-testid="password-username"]') ?? null,
        "alice@example.com",
      );
      setValue(
        editor?.querySelector('[data-testid="password-note"]') ?? null,
        "Recovery code 1234",
      );
    });
    await act(async () =>
      editor
        ?.querySelector<HTMLButtonElement>('[data-testid="password-generate"]')
        ?.click(),
    );
    expect(
      editor?.querySelector<HTMLInputElement>('[data-testid="password-value"]')
        ?.value,
    ).toBe("Gen3rated-Pass.x");
    await act(async () => {
      editor?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(desktopApi.vaultSave).toHaveBeenCalledWith({
      profileId: "profile-1",
      origin: "https://accounts.example.com",
      username: "alice@example.com",
      password: "Gen3rated-Pass.x",
      note: "Recovery code 1234",
    });
  });

  it("filters by website and username, with every term required", async () => {
    vi.mocked(desktopApi.vaultList).mockResolvedValueOnce([alice, bob]);
    await render();
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="password-search"]',
    );
    await act(async () => setValue(search, "example alice"));
    expect(
      container.querySelectorAll('[data-testid="password-row"]'),
    ).toHaveLength(1);
    await act(async () => {
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(search?.value).toBe("");
    expect(
      container.querySelectorAll('[data-testid="password-row"]'),
    ).toHaveLength(2);
  });

  it("reveals the password and note, copies, and confirms deletion", async () => {
    vi.mocked(desktopApi.vaultList).mockResolvedValueOnce([alice]);
    vi.mocked(desktopApi.vaultReveal).mockResolvedValueOnce({
      ...alice,
      password: "correct horse battery staple",
      note: "Security question: blue",
    });
    await render();
    expect(
      container.querySelector('[data-testid="password-row-note"]'),
    ).not.toBeNull();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Reveal password for accounts.example.com"]',
        )
        ?.click(),
    );
    expect(
      container.querySelector('[data-testid="revealed-password"]')?.textContent,
    ).toBe("correct horse battery staple");
    expect(
      container.querySelector('[data-testid="revealed-note"]')?.textContent,
    ).toBe("Security question: blue");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Copy password for accounts.example.com"]',
        )
        ?.click(),
    );
    expect(
      container.querySelector(
        '[aria-label="Password for accounts.example.com copied"]',
      ),
    ).not.toBeNull();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Delete password for accounts.example.com"]',
        )
        ?.click(),
    );
    expect(document.body.textContent).toContain(
      "Delete the password for accounts.example.com?",
    );
  });

  it("edits the username and note without touching the password", async () => {
    vi.mocked(desktopApi.vaultList).mockResolvedValueOnce([alice]);
    vi.mocked(desktopApi.vaultReveal).mockResolvedValueOnce({
      ...alice,
      password: "secret",
      note: "old note",
    });
    vi.mocked(desktopApi.vaultUpdate).mockResolvedValueOnce(alice);
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Edit password for accounts.example.com"]',
        )
        ?.click(),
    );
    const editor = document.querySelector('[data-testid="password-editor"]');
    const note = editor?.querySelector<HTMLTextAreaElement>(
      '[data-testid="password-note"]',
    );
    expect(note?.value).toBe("old note");
    await act(async () => setValue(note ?? null, "new note"));
    await act(async () => {
      editor?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(desktopApi.vaultUpdate).toHaveBeenCalledWith({
      profileId: "profile-1",
      id: alice.id,
      origin: alice.origin,
      username: alice.username,
      note: "new note",
    });
  });

  it("lists never-saved sites and allows saving again", async () => {
    vi.mocked(desktopApi.vaultNeverSaved).mockResolvedValueOnce([
      "https://bank.example",
    ]);
    await render();
    expect(container.textContent).toContain("Never saved");
    const allow = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Allow saving"),
    );
    await act(async () => allow?.click());
    expect(desktopApi.vaultAllowSaving).toHaveBeenCalledWith({
      profileId: "profile-1",
      origin: "https://bank.example",
    });
  });
});
