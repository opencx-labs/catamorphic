import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PasswordVault } from "./browser-vault.js";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
  },
  systemPreferences: { canPromptTouchID: () => false },
}));
const directories: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "catamorphic-import-vault-"),
  );
  directories.push(dir);
  return { dir, vault: new PasswordVault(dir) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
it("preserves destination passwords, imports once and persists an encrypted vault", async () => {
  const { dir, vault } = fixture();
  const account = {
    origin: "https://example.com",
    username: "alice",
    password: "existing-fixture",
  };
  const kept = await vault.save("profile", account);
  const incoming = {
    origin: "https://new.example",
    username: "bob",
    password: "imported-fixture",
  };
  expect(
    await vault.importMissing({
      profileId: "profile",
      credentials: [
        { ...account, password: "replacement" },
        incoming,
        incoming,
      ],
    }),
  ).toEqual({ imported: 1, existing: 2 });
  const reopened = new PasswordVault(dir);
  expect(await reopened.list("profile")).toHaveLength(2);
  expect((await reopened.reveal("profile", kept.id))?.password).toBe(
    "existing-fixture",
  );
  const bytes = fs.readFileSync(path.join(dir, "profile/vault.kdbx"));
  expect(bytes.includes(Buffer.from("imported-fixture"))).toBe(false);
});
it("keeps the previous vault on disk and rolls back imports when persistence fails", async () => {
  const { dir, vault } = fixture();
  await vault.list("profile");
  const before = fs.readFileSync(path.join(dir, "profile/vault.kdbx"));
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("disk error");
  });
  await expect(
    vault.importMissing({
      profileId: "profile",
      credentials: [
        { origin: "https://new.example", username: "bob", password: "fixture" },
      ],
    }),
  ).rejects.toThrow("disk error");
  expect(await vault.list("profile")).toEqual([]);
  expect(fs.readFileSync(path.join(dir, "profile/vault.kdbx"))).toEqual(before);
  expect(
    fs
      .readdirSync(path.join(dir, "profile"))
      .some((name) => name.endsWith(".tmp")),
  ).toBe(false);
});
