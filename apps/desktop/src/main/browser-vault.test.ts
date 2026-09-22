import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptStringAsync: encryption.encrypt,
    decryptStringAsync: vi.fn(),
  },
  systemPreferences: {
    canPromptTouchID: () => false,
  },
}));

const directories: string[] = [];

afterEach(() => {
  encryption.encrypt.mockReset();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PasswordVault", () => {
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
