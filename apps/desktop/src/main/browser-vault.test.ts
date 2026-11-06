import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({
  available: true,
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
  decrypt:
    vi.fn<
      (value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
    >(),
}));

vi.mock("electron", () => ({
  safeStorage: {
    getSelectedStorageBackend: () => "gnome_libsecret",
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => encryption.available,
    encryptStringAsync: encryption.encrypt,
    decryptStringAsync: encryption.decrypt,
  },
  systemPreferences: {
    canPromptTouchID: () => false,
  },
}));

const directories: string[] = [];

afterEach(() => {
  encryption.encrypt.mockReset();
  encryption.decrypt.mockReset();
  encryption.available = true;
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PasswordVault", () => {
  it("reports unavailable OS storage with guidance before creating a vault", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-browser-vault-"),
    );
    directories.push(directory);
    encryption.available = false;
    const { PasswordVault } = await import("./browser-vault.js");
    await expect(new PasswordVault(directory).list("profile")).rejects.toThrow(
      "Unlock your operating system's keychain",
    );
    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, "profile/vault.key"))).toBe(
      false,
    );
  });

  it("preserves saved passwords on async keychain failure and retries after unlock", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-browser-vault-"),
    );
    directories.push(directory);
    encryption.encrypt.mockResolvedValue(Buffer.from("sealed-key"));
    const { PasswordVault } = await import("./browser-vault.js");
    const vault = new PasswordVault(directory);
    await vault.save("profile", {
      origin: "https://example.test",
      username: "alice",
      password: "saved-password",
    });
    const key = encryption.encrypt.mock.calls[0]?.[0];
    if (!key) throw new Error("Test vault key missing");
    const keyFile = path.join(directory, "profile/vault.key");
    const vaultFile = path.join(directory, "profile/vault.kdbx");
    const savedKey = fs.readFileSync(keyFile);
    const savedVault = fs.readFileSync(vaultFile);
    vault.releaseProfile("profile");
    encryption.decrypt.mockRejectedValueOnce(
      new Error("Provider failure with private detail"),
    );
    await expect(vault.list("profile")).rejects.toThrow(
      "Work could not unlock the saved credential",
    );
    expect(fs.readFileSync(keyFile)).toEqual(savedKey);
    expect(fs.readFileSync(vaultFile)).toEqual(savedVault);
    encryption.decrypt.mockResolvedValue({
      result: key,
      shouldReEncrypt: false,
    });
    await expect(vault.list("profile")).resolves.toMatchObject([
      { username: "alice" },
    ]);
  });
  it("coalesces concurrent profile unlocks into one Keychain access", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-browser-vault-"),
    );
    directories.push(directory);
    let resolveEncryption: ((value: Buffer) => void) | undefined;
    encryption.encrypt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEncryption = resolve;
        }),
    );
    const { PasswordVault } = await import("./browser-vault.js");
    const vault = new PasswordVault(directory);

    const first = vault.list("profile-1");
    const second = vault.list("profile-1");
    await vi.waitFor(() => expect(encryption.encrypt).toHaveBeenCalledOnce());

    resolveEncryption?.(Buffer.from("sealed-key"));
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(encryption.encrypt).toHaveBeenCalledOnce();
  });

  it("keeps notes behind reveal and tells a changed password from the same one", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-browser-vault-"),
    );
    directories.push(directory);
    encryption.encrypt.mockResolvedValue(Buffer.from("sealed-key"));
    const { PasswordVault } = await import("./browser-vault.js");
    const vault = new PasswordVault(directory);
    const origin = "https://accounts.example.com";

    const saved = await vault.save("profile-1", {
      origin,
      username: "alice",
      password: "first",
      note: "Recovery: 1234",
    });
    expect(saved).toMatchObject({ username: "alice", hasNote: true });
    const [listed] = await vault.list("profile-1");
    expect(listed).not.toHaveProperty("note");
    expect(await vault.reveal("profile-1", saved.id)).toMatchObject({
      password: "first",
      note: "Recovery: 1234",
    });

    await expect(
      vault.match("profile-1", {
        origin,
        username: "alice",
        password: "first",
      }),
    ).resolves.toEqual({ status: "same", id: saved.id });
    await expect(
      vault.match("profile-1", { origin, username: "alice", password: "next" }),
    ).resolves.toEqual({ status: "changed", id: saved.id });
    await expect(
      vault.match("profile-1", { origin, username: "", password: "first" }),
    ).resolves.toEqual({ status: "same", id: saved.id });
    await expect(
      vault.match("profile-1", { origin, username: "bob", password: "first" }),
    ).resolves.toEqual({ status: "new" });

    // Updating the username keeps the note unless one is given.
    await vault.update("profile-1", saved.id, { origin, username: "alice2" });
    expect(await vault.reveal("profile-1", saved.id)).toMatchObject({
      username: "alice2",
      note: "Recovery: 1234",
    });
    await vault.update("profile-1", saved.id, {
      origin,
      username: "alice2",
      note: "",
    });
    expect((await vault.list("profile-1"))[0]?.hasNote).toBe(false);
  });

  it("remembers sites never to save for", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-browser-vault-"),
    );
    directories.push(directory);
    encryption.encrypt.mockResolvedValue(Buffer.from("sealed-key"));
    const { PasswordVault } = await import("./browser-vault.js");
    const vault = new PasswordVault(directory);
    await vault.setNeverSave("profile-1", "https://bank.example/login", true);
    await vault.setNeverSave("profile-1", "https://a.example", true);
    expect(await vault.neverSaved("profile-1")).toEqual([
      "https://a.example",
      "https://bank.example",
    ]);
    await vault.setNeverSave("profile-1", "https://bank.example", false);
    expect(await vault.neverSaved("profile-1")).toEqual(["https://a.example"]);
  });
});
