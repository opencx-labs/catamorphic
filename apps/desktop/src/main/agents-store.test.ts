import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  SANDBOXING_LEVELS,
} from "@catamorphic/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  CODEX_APPROVAL_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  SANDBOXING_OPTIONS,
} from "../shared/agent-permissions.js";

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
  it("persists instructions, sandboxing, permission mode, memory, skills, and coordination; defaults stay implicit", () => {
    const file = storeFile();
    const store = new AgentsStore(file);
    const agent = store.create({
      harness: "claude-code",
      instructions: "  You are the reviewer.  ",
      sandboxing: "contained",
      harnessPermissions: { permissionMode: "plan" },
      memory: true,
      skills: { mode: "picked", names: ["publishing-to-github"] },
      coordination: "isolate-on-contention",
      delegation: {
        enabled: true,
        maxConcurrentChildren: 4,
        routes: [
          {
            id: "reviewer",
            target: "project:reviewer",
            allowFurtherDelegation: false,
          },
        ],
      },
    });
    expect(agent.instructions).toBe("You are the reviewer.");
    expect(agent.sandboxing).toBe("contained");
    expect(agent.harnessPermissions).toEqual({ permissionMode: "plan" });
    expect(agent.memory).toBe(true);
    expect(agent.skills).toEqual({
      mode: "picked",
      names: ["publishing-to-github"],
    });
    expect(agent.coordination).toBe("isolate-on-contention");
    expect(agent.delegation).toEqual({
      enabled: true,
      maxConcurrentChildren: 4,
      routes: [
        {
          id: "reviewer",
          target: "project:reviewer",
          allowFurtherDelegation: false,
        },
      ],
    });

    // Defaults are absent on disk, not stored as literals: the file grows
    // only what deviates.
    const plain = store.create({ harness: "codex" });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const stored = raw.agents.find(
      (candidate: { id: string }) => candidate.id === plain.id,
    );
    expect(stored.sandboxing).toBeUndefined();
    expect(stored.harnessPermissions).toBeUndefined();
    expect(stored.memory).toBeUndefined();
    expect(stored.skills).toBeUndefined();
    expect(stored.instructions).toBeUndefined();
    expect(stored.coordination).toBeUndefined();

    // The public shape materializes them for the renderer. Memory is
    // OPT-IN (ADR 0056): a fresh agent remembers nothing.
    const publicAgent = toPublicAgent(plain);
    // Local agents default to full freedom (ADR 0140), in each setting.
    expect(publicAgent.sandboxing).toBe("publish");
    expect(publicAgent.harnessPermissions).toEqual({
      sandbox: "danger-full-access",
      approvals: "on-request",
    });
    expect(
      toPublicAgent(store.create({ harness: "claude-code" }))
        .harnessPermissions,
    ).toEqual({ permissionMode: "bypassPermissions" });
    expect(
      toPublicAgent(store.create({ harness: "ai-sdk" })).harnessPermissions,
    ).toEqual({});
    expect(publicAgent.memory).toBe(false);
    expect(publicAgent.skills).toEqual({ mode: "all" });
    expect(publicAgent.instructions).toBe("");
    expect(publicAgent.coordination).toBe("shared-first");
    expect(publicAgent.delegation).toMatchObject({
      enabled: true,
      maxConcurrentChildren: 10,
      routes: [{ id: "same-agent", target: "self" }],
    });
  });

  it("update clears back to defaults including shared-first coordination", () => {
    const store = new AgentsStore(storeFile());
    const agent = store.create({
      harness: "claude-code",
      instructions: "persona",
      sandboxing: "publish",
      harnessPermissions: { permissionMode: "auto" },
      memory: true,
      skills: { mode: "picked", names: ["a"] },
      coordination: "isolation-required",
      delegation: {
        enabled: false,
        maxConcurrentChildren: 2,
        routes: [],
      },
    });
    const updated = store.update(agent.id, {
      instructions: "",
      sandboxing: "propose",
      harnessPermissions: {},
      memory: false,
      skills: { mode: "all" },
      coordination: "shared-first",
      delegation: {
        enabled: true,
        maxConcurrentChildren: 10,
        routes: [
          {
            id: "same-agent",
            target: "self",
            allowFurtherDelegation: true,
          },
        ],
      },
    });
    expect(updated?.instructions).toBeUndefined();
    expect(updated?.sandboxing).toBe("propose");
    expect(updated?.harnessPermissions).toBeUndefined();
    expect(updated?.memory).toBeUndefined();
    expect(updated?.skills).toBeUndefined();
    expect(updated?.coordination).toBeUndefined();
    expect(updated?.delegation).toMatchObject({
      enabled: true,
      maxConcurrentChildren: 10,
    });
  });
});

describe("AgentsStore: permission mode and sandboxing (ADR 0182)", () => {
  it("takes each harness's own settings and refuses another harness's", () => {
    const store = new AgentsStore(storeFile());
    const codex = store.create({
      harness: "codex",
      harnessPermissions: { sandbox: "workspace-write" },
    });
    expect(toPublicAgent(codex).harnessPermissions).toEqual({
      sandbox: "workspace-write",
      approvals: "on-request",
    });
    expect(
      store.update(codex.id, {
        harnessPermissions: { sandbox: "workspace-write", approvals: "never" },
      })?.harnessPermissions,
    ).toEqual({ sandbox: "workspace-write", approvals: "never" });
    expect(() =>
      store.update(codex.id, {
        harnessPermissions: { permissionMode: "auto" },
      }),
    ).toThrow("A codex agent takes 'sandbox' and 'approvals'");
    expect(() =>
      store.create({
        harness: "ai-sdk",
        harnessPermissions: { permissionMode: "plan" },
      }),
    ).toThrow("has no harness permission settings");
    // Sandboxing and permission mode are independent: bypassing the
    // harness's checks inside a contained sandbox is valid.
    const fast = store.create({
      harness: "claude-code",
      sandboxing: "contained",
      harnessPermissions: { permissionMode: "bypassPermissions" },
    });
    expect(toPublicAgent(fast)).toMatchObject({
      sandboxing: "contained",
      harnessPermissions: { permissionMode: "bypassPermissions" },
    });
  });

  it("mirrors the harness values the sandbox package defines", () => {
    expect(SANDBOXING_OPTIONS.map((option) => option.value)).toEqual([
      ...SANDBOXING_LEVELS,
    ]);
    expect(
      CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => option.value).sort(),
    ).toEqual([...CLAUDE_CODE_PERMISSION_MODES].sort());
    expect(CODEX_SANDBOX_OPTIONS.map((option) => option.value).sort()).toEqual(
      [...CODEX_SANDBOX_MODES].sort(),
    );
    expect(CODEX_APPROVAL_OPTIONS.map((option) => option.value).sort()).toEqual(
      [...CODEX_APPROVAL_POLICIES].sort(),
    );
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

it("advertises the native Codex attachment path to the composer", () => {
  const store = new AgentsStore(storeFile());
  expect(toPublicAgent(store.create({ harness: "codex" })).accepts).toEqual([
    "image",
    "document",
  ]);
});
