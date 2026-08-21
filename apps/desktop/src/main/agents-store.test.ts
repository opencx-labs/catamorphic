import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The store encrypts via Electron's safeStorage; unit tests run outside
// Electron, so exercise a reversible stand-in cipher.
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf-8"),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString("utf-8");
      if (!raw.startsWith("enc:")) throw new Error("bad ciphertext");
      return raw.slice(4);
    },
  },
}));

const { AgentsStore, toPublicAgent } = await import("./agents-store.js");

const tmpdirs: string[] = [];
function storeFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-store-"));
  tmpdirs.push(dir);
  return path.join(dir, "agents.json");
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("AgentsStore — ADR 0056 fields", () => {
  it("persists instructions, mode, memory, and skills; defaults stay implicit", () => {
    const file = storeFile();
    const store = new AgentsStore(file);
    const agent = store.create({
      harness: "claude-code",
      instructions: "  You are the reviewer.  ",
      mode: "read-only",
      memory: false,
      skills: { mode: "picked", names: ["publishing-to-github"] },
    });
    expect(agent.instructions).toBe("You are the reviewer.");
    expect(agent.mode).toBe("read-only");
    expect(agent.memory).toBe(false);
    expect(agent.skills).toEqual({
      mode: "picked",
      names: ["publishing-to-github"],
    });

    // Defaults are absent on disk, not stored as literals: the file grows
    // only what deviates.
    const plain = store.create({ harness: "codex" });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const stored = raw.agents.find(
      (candidate: { id: string }) => candidate.id === plain.id,
    );
    expect(stored.mode).toBeUndefined();
    expect(stored.memory).toBeUndefined();
    expect(stored.skills).toBeUndefined();
    expect(stored.instructions).toBeUndefined();

    // The public shape materializes them for the renderer.
    const publicAgent = toPublicAgent(plain);
    expect(publicAgent.mode).toBe("edit");
    expect(publicAgent.memory).toBe(true);
    expect(publicAgent.skills).toEqual({ mode: "all" });
    expect(publicAgent.instructions).toBe("");
  });

  it("update clears back to defaults ('' instructions, edit mode, memory on, all skills)", () => {
    const store = new AgentsStore(storeFile());
    const agent = store.create({
      harness: "claude-code",
      instructions: "persona",
      mode: "full-access",
      memory: false,
      skills: { mode: "picked", names: ["a"] },
    });
    const updated = store.update(agent.id, {
      instructions: "",
      mode: "edit",
      memory: true,
      skills: { mode: "all" },
    });
    expect(updated?.instructions).toBeUndefined();
    expect(updated?.mode).toBeUndefined();
    expect(updated?.memory).toBeUndefined();
    expect(updated?.skills).toBeUndefined();
  });
});

describe("AgentsStore — layered defaults (ADR 0056)", () => {
  it("stores per-project overrides, validates them, and clears on removal", () => {
    const store = new AgentsStore(storeFile());
    const first = store.create({ harness: "claude-code" });
    const second = store.create({ harness: "codex" });

    store.setProjectDefault(PROJECT, second.id);
    expect(store.projectDefault(PROJECT)).toBe(second.id);
    expect(store.projectDefaults()).toEqual({ [PROJECT]: second.id });
    // The global default is untouched (first created agent).
    expect(store.defaultAgentId()).toBe(first.id);

    // Unknown agent ids are refused; project: ids taken at face value.
    store.setProjectDefault(PROJECT, "nonsense");
    expect(store.projectDefault(PROJECT)).toBe(second.id);
    store.setProjectDefault(PROJECT, `project:${PROJECT}:triage`);
    expect(store.projectDefault(PROJECT)).toBe(`project:${PROJECT}:triage`);

    // Clearing, and cleanup when the named agent is removed.
    store.setProjectDefault(PROJECT, second.id);
    store.remove(second.id);
    expect(store.projectDefault(PROJECT)).toBeUndefined();
    store.setProjectDefault(PROJECT, null);
    expect(store.projectDefaults()).toEqual({});
  });
});
