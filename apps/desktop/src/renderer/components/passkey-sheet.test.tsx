// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PasskeyRequest } from "../../shared/passkeys.js";
import { desktopApi } from "../lib/desktop-api.js";
import { PASSKEY_INPUT_PROTECTION_MS, PasskeyHost } from "./passkey-sheet.js";

const listeners = vi.hoisted(() => ({
  request: null as ((request: PasskeyRequest) => void) | null,
  settled: null as ((payload: { ids: string[] }) => void) | null,
}));

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    onPasskeyRequest: vi.fn((listener) => {
      listeners.request = listener;
      return () => undefined;
    }),
    onPasskeySettled: vi.fn((listener) => {
      listeners.settled = listener;
      return () => undefined;
    }),
    passkeyCancel: vi.fn().mockResolvedValue(true),
    passkeyUse: vi.fn(),
    passkeySave: vi.fn(),
    authorizationStatus: vi.fn().mockResolvedValue(null),
    authorizationContinueBrowser: vi.fn(),
  },
}));

const base: PasskeyRequest = {
  id: "request-1",
  guestId: 7,
  origin: "https://app.example.com",
  rpId: "example.com",
  kind: "get",
  passkeys: [],
  verifies: true,
};

describe("PasskeyHost", () => {
  let container: HTMLDivElement;
  let root: Root;
  const openPasswords = vi.fn();
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    // A frame comes after the effects that scheduled it, as in a browser.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <PasskeyHost onOpenPasswords={openPasswords} />
        </QueryClientProvider>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const wait = (ms: number) =>
    act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  /** Shows a request and waits out the sheet's input protection. */
  const show = async (request: PasskeyRequest, armed = true) => {
    await act(async () => listeners.request?.(request));
    await wait(armed ? PASSKEY_INPUT_PROTECTION_MS + 20 : 0);
  };
  const sheet = () => document.querySelector('[data-testid="passkey-sheet"]');
  const click = async (selector: string) =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(selector)?.click(),
    );

  it("signs in with a saved passkey, and lets a refused Touch ID try again", async () => {
    vi.mocked(desktopApi.passkeyUse)
      .mockResolvedValueOnce("refused")
      .mockResolvedValueOnce("used");
    await show({
      ...base,
      passkeys: [
        { id: "a", username: "ada@example.com" },
        { id: "b", username: "grace@example.com" },
      ],
    });
    const choices = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="passkey-sheet-choice"]',
    );
    expect([...choices].map((choice) => choice.textContent)).toEqual([
      "ada@example.comPasskey saved in Work",
      "grace@example.comPasskey saved in Work",
    ]);
    // The first passkey has focus, so Enter signs in at once.
    expect(document.activeElement).toBe(choices[0]);
    expect(sheet()?.textContent).toContain(
      "Or use a security key: insert it and touch it.",
    );
    await act(async () => choices[1]?.click());
    expect(desktopApi.passkeyUse).toHaveBeenCalledWith({
      id: "request-1",
      passkeyId: "b",
    });
    expect(
      document.querySelector('[data-testid="passkey-sheet-error"]')
        ?.textContent,
    ).toBe("Touch ID didn't confirm it. Try again.");
    // Trying again starts from the passkey that was refused.
    expect(document.activeElement).toBe(choices[1]);
    await act(async () => choices[1]?.click());
    expect(desktopApi.passkeyUse).toHaveBeenCalledTimes(2);
    // Main settles the request once the page has its credential; the
    // sheet closes without cancelling anything.
    await act(async () => listeners.settled?.({ ids: ["request-1"] }));
    expect(
      document
        .querySelector('[role="dialog"]')
        ?.className.includes("animate-modal-in") ?? false,
    ).toBe(false);
    expect(desktopApi.passkeyCancel).not.toHaveBeenCalled();
  });

  it("ignores a click that lands as the sheet appears", async () => {
    await show(
      { ...base, passkeys: [{ id: "a", username: "ada@example.com" }] },
      false,
    );
    await click('[data-testid="passkey-sheet-choice"]');
    expect(desktopApi.passkeyUse).not.toHaveBeenCalled();
    await wait(PASSKEY_INPUT_PROTECTION_MS + 20);
    await click('[data-testid="passkey-sheet-choice"]');
    expect(desktopApi.passkeyUse).toHaveBeenCalledTimes(1);
  });

  it("keeps Enter from answering when no Touch ID stands behind it", async () => {
    await show({
      ...base,
      verifies: false,
      passkeys: [{ id: "a", username: "ada@example.com" }],
    });
    expect(
      document.activeElement?.closest('[data-testid="passkey-sheet-choice"]'),
    ).toBeNull();
  });

  it("explains what can answer when Work has no passkey for the site", async () => {
    await show(base);
    const text = sheet()?.textContent ?? "";
    expect(text).toContain("No passkey for example.com is saved in Work.");
    expect(text).toContain("Waiting for a security key.");
    await click('[data-testid="passkey-sheet-import"]');
    expect(desktopApi.passkeyCancel).toHaveBeenCalledWith({ id: "request-1" });
    expect(openPasswords).toHaveBeenCalled();
  });

  it("saves a new passkey for the account the site names", async () => {
    vi.mocked(desktopApi.passkeySave).mockResolvedValueOnce("used");
    await show({
      ...base,
      kind: "create",
      account: { name: "ada@example.com", displayName: "Ada Lovelace" },
    });
    expect(sheet()?.textContent).toContain("wants to create a passkey");
    expect(
      document.querySelector('[data-testid="passkey-sheet-account"]')
        ?.textContent,
    ).toBe("ada@example.com");
    expect(sheet()?.textContent).toContain("Ada Lovelace");
    await click('[data-testid="passkey-sheet-save"]');
    expect(desktopApi.passkeySave).toHaveBeenCalledWith({ id: "request-1" });
  });

  it("says an account already has a passkey here, and OK ends the request", async () => {
    await show({
      ...base,
      kind: "create",
      account: { name: "ada", displayName: "Ada" },
      unavailable: "excluded",
    });
    expect(sheet()?.textContent).toContain(
      "A passkey for this account is already saved in Work.",
    );
    expect(
      document.querySelector('[data-testid="passkey-sheet-save"]'),
    ).toBeNull();
    const ok = document.querySelector<HTMLButtonElement>(
      '[data-testid="passkey-sheet-cancel"]',
    );
    expect(ok?.textContent).toBe("OK");
    await act(async () => ok?.click());
    expect(desktopApi.passkeyCancel).toHaveBeenCalledWith({ id: "request-1" });
  });

  it("names why Work can't answer a security-key-only or Touch ID request", async () => {
    await show({ ...base, kind: "create", unavailable: "security-key-only" });
    expect(sheet()?.textContent).toContain(
      "app.example.com asks for a security key",
    );
    await act(async () => listeners.settled?.({ ids: ["request-1"] }));
    await show({
      ...base,
      id: "request-2",
      unavailable: "verification-unavailable",
      verifies: false,
    });
    expect(sheet()?.textContent).toContain(
      "requires Touch ID to sign in with a passkey",
    );
    await act(async () => listeners.settled?.({ ids: ["request-2"] }));
    // A locked keychain still leaves a cancellable sheet, not a spinner.
    await show({ ...base, id: "request-3", unavailable: "vault-unavailable" });
    expect(sheet()?.textContent).toContain(
      "Work can't open this profile's saved passkeys right now.",
    );
    expect(sheet()?.textContent).toContain("Waiting for a security key.");
  });
});
