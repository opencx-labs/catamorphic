import { afterEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({ isPackaged: false }));
vi.mock("electron", () => ({ app: application, safeStorage: {} }));

afterEach(() => {
  application.isPackaged = false;
});

import {
  CredentialStorageError,
  credentialEncryptionAvailable,
  credentialEncryptionAvailableAsync,
  credentialUnlockError,
} from "./credential-encryption.js";

describe("credential encryption", () => {
  it("exposes actionable host guidance without exposing the keychain's failure details", () => {
    const cause = new Error("private keychain detail");
    const error = credentialUnlockError({ cause });
    expect(error).toBeInstanceOf(CredentialStorageError);
    expect(error.message).toContain("Unlock your operating system's keychain");
    expect(error.message).toContain("Settings");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });
  it.each(["basic_text", "unknown"] as const)(
    "refuses Linux's %s backend for real profiles",
    (backend) => {
      expect(
        credentialEncryptionAvailable({
          platform: "linux",
          storage: {
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => backend,
          },
        }),
      ).toBe(false);
    },
  );
  it("accepts an OS keyring and retains the isolated E2E exception", () => {
    const storage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: (): "gnome_libsecret" => "gnome_libsecret",
    };
    expect(credentialEncryptionAvailable({ platform: "linux", storage })).toBe(
      true,
    );
    expect(credentialEncryptionAvailable({ platform: "darwin", storage })).toBe(
      true,
    );
    expect(
      credentialEncryptionAvailable({
        platform: "linux",
        e2eDataDir: "/tmp/work-e2e",
        storage: { ...storage, getSelectedStorageBackend: () => "basic_text" },
      }),
    ).toBe(true);
    expect(
      credentialEncryptionAvailable({
        platform: "darwin",
        storage: { ...storage, isEncryptionAvailable: () => false },
      }),
    ).toBe(false);
  });
  it("checks async keychain availability before rejecting insecure Linux backends", async () => {
    for (const backend of [
      "basic_text",
      "unknown",
      "gnome_libsecret",
    ] as const) {
      const isAsyncEncryptionAvailable = vi.fn(async () => true);
      expect(
        await credentialEncryptionAvailableAsync({
          platform: "linux",
          storage: {
            isAsyncEncryptionAvailable,
            getSelectedStorageBackend: () => backend,
          },
        }),
      ).toBe(backend === "gnome_libsecret");
      expect(isAsyncEncryptionAvailable).toHaveBeenCalledOnce();
    }
    const getSelectedStorageBackend = vi.fn(() => "gnome_libsecret" as const);
    expect(
      await credentialEncryptionAvailableAsync({
        platform: "linux",
        storage: {
          isAsyncEncryptionAvailable: async () => false,
          getSelectedStorageBackend,
        },
      }),
    ).toBe(false);
    expect(getSelectedStorageBackend).not.toHaveBeenCalled();
  });
  it("never lets a packaged app opt into the E2E plaintext backend", async () => {
    application.isPackaged = true;
    const storage = {
      isEncryptionAvailable: () => true,
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "basic_text" as const,
    };
    const options = {
      platform: "linux" as const,
      e2eDataDir: "/tmp/work-e2e",
      storage,
    };
    expect(credentialEncryptionAvailable(options)).toBe(false);
    expect(await credentialEncryptionAvailableAsync(options)).toBe(false);
  });
});
