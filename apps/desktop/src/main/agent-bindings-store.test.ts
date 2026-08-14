import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { definitionHash } from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// The store encrypts via Electron's safeStorage; unit tests run outside
// Electron, so exercise a reversible stand-in cipher (the plaintext
// fallback path is covered separately by flipping availability).
let encryptionAvailable = true;
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf-8"),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString("utf-8");
      if (!raw.startsWith("enc:")) throw new Error("bad ciphertext");
      return raw.slice(4);
    },
  },
}));

const { AgentBindingsStore } = await import("./agent-bindings-store.js");

const tmpdirs: string[] = [];
function storeFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bindings-"));
  tmpdirs.push(dir);
  return path.join(dir, "agent-bindings.json");
}

afterEach(() => {
  encryptionAvailable = true;
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("AgentBindingsStore", () => {
  it("round-trips a binding with an encrypted API key", () => {
    const file = storeFile();
    const store = new AgentBindingsStore(file);
    store.bind(PROJECT, "triage", {
      consentHash: "hash-1",
      auth: { mode: "api-key", apiKey: "sk-ant-secret" },
    });

    // Fresh instance: state must come from disk, key decrypted on read.
    const reloaded = new AgentBindingsStore(file);
    expect(reloaded.get(PROJECT, "triage")).toEqual({
      consentHash: "hash-1",
      auth: { mode: "api-key", apiKey: "sk-ant-secret" },
    });

    // The raw key never lands on disk.
    const onDisk = fs.readFileSync(file, "utf-8");
    expect(onDisk).not.toContain("sk-ant-secret");
    expect(onDisk).toContain("apiKeyEncrypted");
  });

  it("round-trips local-auth bindings and removals", () => {
    const store = new AgentBindingsStore(storeFile());
    store.bind(PROJECT, "reviewer", {
      consentHash: "hash-2",
      auth: { mode: "local" },
    });
    expect(store.get(PROJECT, "reviewer")).toEqual({
      consentHash: "hash-2",
      auth: { mode: "local" },
    });
    expect(store.get(PROJECT, "other")).toBeUndefined();
    expect(store.remove(PROJECT, "reviewer")).toBe(true);
    expect(store.get(PROJECT, "reviewer")).toBeUndefined();
    expect(store.remove(PROJECT, "reviewer")).toBe(false);
  });

  it("scopes bindings by project", () => {
    const store = new AgentBindingsStore(storeFile());
    store.bind(PROJECT, "triage", { consentHash: "hash-a" });
    expect(
      store.get("22222222-2222-4222-8222-222222222222", "triage"),
    ).toBeUndefined();
  });

  it("stores plaintext (with the documented fallback) when the keychain is unavailable", () => {
    encryptionAvailable = false;
    const file = storeFile();
    const store = new AgentBindingsStore(file);
    store.bind(PROJECT, "triage", {
      consentHash: "hash-3",
      auth: { mode: "api-key", apiKey: "sk-plain" },
    });
    expect(fs.readFileSync(file, "utf-8")).toContain("apiKeyPlaintext");
    expect(new AgentBindingsStore(file).get(PROJECT, "triage")?.auth).toEqual({
      mode: "api-key",
      apiKey: "sk-plain",
    });
  });

  it("consent goes stale when the definition's sensitive fields change", () => {
    const store = new AgentBindingsStore(storeFile());
    const definition = {
      version: 1 as const,
      name: "Support Triage",
      kind: "claude-code" as const,
      credentials: { source: "profile" as const },
    };
    const consented = definitionHash(definition, "persona v1");
    store.bind(PROJECT, "triage", {
      consentHash: consented,
      auth: { mode: "local" },
    });

    // Same definition state → consent holds.
    expect(store.get(PROJECT, "triage")?.consentHash).toBe(
      definitionHash(definition, "persona v1"),
    );
    // Persona edit → hash moves → the stored consent no longer matches.
    expect(store.get(PROJECT, "triage")?.consentHash).not.toBe(
      definitionHash(definition, "persona v2"),
    );
    // Display-only edits (description) leave consent intact.
    expect(store.get(PROJECT, "triage")?.consentHash).toBe(
      definitionHash({ ...definition, description: "new words" }, "persona v1"),
    );
  });
});
