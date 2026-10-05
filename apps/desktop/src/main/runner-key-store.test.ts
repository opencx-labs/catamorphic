import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executorPublicKey,
  generateExecutorKeyPair,
} from "@catamorphic/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    // Reversible, and visibly not the plaintext.
    encryptString: (value: string) =>
      Buffer.from(
        Buffer.from(value).toString("base64").split("").reverse().join(""),
      ),
    decryptString: (value: Buffer) =>
      Buffer.from(
        value.toString("utf8").split("").reverse().join(""),
        "base64",
      ).toString("utf8"),
  },
}));

import { RunnerKeyStore } from "./runner-key-store.js";

describe("RunnerKeyStore (ADR 0206)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    encryption.available = true;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-key-"));
    file = path.join(dir, "profiles", "default", "runner-key.json");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps one key per profile, owner-only and encrypted at rest", () => {
    const first = new RunnerKeyStore(file).keyPair();
    expect(executorPublicKey(first.privateKey)).toBe(first.publicKey);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stored = fs.readFileSync(file, "utf8");
    expect(stored).toContain(first.publicKey);
    expect(stored).not.toContain("PRIVATE KEY");
    // The next start reads the same key back.
    expect(new RunnerKeyStore(file).keyPair()).toEqual(first);
  });

  it("starts anew when the stored key was altered", () => {
    const first = new RunnerKeyStore(file).keyPair();
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...record,
        publicKey: generateExecutorKeyPair().publicKey,
      }),
    );
    const next = new RunnerKeyStore(file).keyPair();
    expect(next.publicKey).not.toBe(first.publicKey);
    expect(executorPublicKey(next.privateKey)).toBe(next.publicKey);
  });

  it("keeps the key only for this session without OS encryption", () => {
    encryption.available = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new RunnerKeyStore(file);
    const keys = store.keyPair();
    expect(store.keyPair()).toBe(keys);
    expect(fs.existsSync(file)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
