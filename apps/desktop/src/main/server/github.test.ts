import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredGithubConnection } from "@catamorphic/github";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({
  decrypt: vi.fn((value: Buffer) => value.toString().replace(/^sealed:/, "")),
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: encryption.decrypt,
  },
}));

const directories: string[] = [];
const connection: StoredGithubConnection = {
  tokens: {
    accessToken: "github-token",
    expiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
  },
  githubLogin: "octocat",
  githubUserId: 1,
};

afterEach(() => {
  encryption.decrypt.mockClear();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FileGithubTokenStore", () => {
  it("decrypts a persisted connection once per app run", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-github-store-"),
    );
    directories.push(directory);
    const file = path.join(directory, "github.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        connectionEncrypted: Buffer.from(
          `sealed:${JSON.stringify(connection)}`,
        ).toString("base64"),
      }),
    );
    const { FileGithubTokenStore } = await import("./github.js");
    const store = new FileGithubTokenStore(file);

    await expect(store.get()).resolves.toEqual(connection);
    await expect(store.get()).resolves.toEqual(connection);
    expect(encryption.decrypt).toHaveBeenCalledOnce();
  });
});
