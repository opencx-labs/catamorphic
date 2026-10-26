import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ safeStorage: {} }));

import { credentialEncryptionAvailable } from "./credential-encryption.js";

describe("credential encryption", () => {
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
});
