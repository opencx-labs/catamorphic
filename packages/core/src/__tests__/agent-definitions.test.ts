import { describe, expect, it } from "vitest";
import {
  type AgentDefinition,
  definitionHash,
  validateAgentDefinition,
} from "../services/agent-definitions-service.js";

const base = {
  version: 1,
  name: "Support Triage",
  kind: "claude-code",
} as const;

describe("validateAgentDefinition", () => {
  it("accepts checkout coordination doctrine and rejects unknown strategies", () => {
    const valid = validateAgentDefinition({
      ...base,
      coordination: "isolate-on-contention",
    });
    expect(valid).toMatchObject({
      definition: { coordination: "isolate-on-contention" },
    });

    const invalid = validateAgentDefinition({
      ...base,
      coordination: "worktree-every-time",
    });
    expect("error" in invalid).toBe(true);
  });
  it("accepts a minimal definition", () => {
    const result = validateAgentDefinition(base);
    expect(result).toEqual({
      definition: { version: 1, name: "Support Triage", kind: "claude-code" },
    });
  });

  it("accepts every field of the full shape", () => {
    const result = validateAgentDefinition({
      ...base,
      kind: "codex",
      model: "gpt-5.3-codex",
      effort: "high",
      description: "Triages incoming support threads",
      credentials: { source: "secret", secret: "OPENAI_KEY" },
      connections: ["slack", "linear"],
    });
    expect("definition" in result && result.definition.credentials).toEqual({
      source: "secret",
      secret: "OPENAI_KEY",
    });
  });

  it("defaults credentials.source to profile", () => {
    const result = validateAgentDefinition({ ...base, credentials: {} });
    expect("definition" in result && result.definition.credentials).toEqual({
      source: "profile",
    });
  });

  it("accepts the reserved acp kind (resolution is the host's concern)", () => {
    const result = validateAgentDefinition({
      ...base,
      kind: "acp",
      acp: { endpoint: "https://agents.example.com/triage" },
    });
    expect("definition" in result).toBe(true);
  });

  it("rejects unknown kinds with the offending path", () => {
    const result = validateAgentDefinition({ ...base, kind: "gemini-cli" });
    expect("error" in result && result.error).toMatch(/kind/);
  });

  it("rejects the e2e-fake kind unless explicitly allowed", () => {
    const raw = { ...base, kind: "e2e-fake" };
    expect("error" in validateAgentDefinition(raw)).toBe(true);
    expect(
      "definition" in validateAgentDefinition(raw, { allowE2eFake: true }),
    ).toBe(true);
  });

  it("reports future versions as unsupported, not half-parsed", () => {
    const result = validateAgentDefinition({ ...base, version: 2 });
    expect("error" in result && result.error).toMatch(
      /Unsupported definition version 2/,
    );
  });

  it("requires a secret name when source is secret", () => {
    const result = validateAgentDefinition({
      ...base,
      credentials: { source: "secret" },
    });
    expect("error" in result && result.error).toMatch(/secret/);
  });

  it("rejects a secret name on non-secret sources", () => {
    const result = validateAgentDefinition({
      ...base,
      credentials: { source: "profile", secret: "KEY" },
    });
    expect("error" in result).toBe(true);
  });

  it("rejects non-objects and missing names without throwing", () => {
    expect("error" in validateAgentDefinition(null)).toBe(true);
    expect("error" in validateAgentDefinition([])).toBe(true);
    expect("error" in validateAgentDefinition("nope")).toBe(true);
    expect(
      "error" in validateAgentDefinition({ version: 1, kind: "codex" }),
    ).toBe(true);
  });

  it("strips unknown top-level keys (forward compatibility)", () => {
    const result = validateAgentDefinition({ ...base, futureKnob: true });
    expect("definition" in result).toBe(true);
    expect(
      "definition" in result &&
        (result.definition as unknown as Record<string, unknown>).futureKnob,
    ).toBeUndefined();
  });
});

describe("definitionHash", () => {
  const def: AgentDefinition = {
    version: 1,
    name: "Support Triage",
    kind: "claude-code",
    model: "claude-fable-5",
    description: "Triages support threads",
    credentials: { source: "profile" },
    connections: ["slack"],
  };

  it("is stable for identical input", () => {
    expect(definitionHash(def, "persona")).toBe(definitionHash(def, "persona"));
  });

  it("treats an absent credentials block as source profile", () => {
    const { credentials: _credentials, ...bare } = def;
    expect(definitionHash(bare as AgentDefinition)).toBe(definitionHash(def));
  });

  it("changes when the persona prompt changes", () => {
    expect(definitionHash(def, "persona A")).not.toBe(
      definitionHash(def, "persona B"),
    );
  });

  it("distinguishes no-prompt-file from an empty prompt file", () => {
    expect(definitionHash(def)).not.toBe(definitionHash(def, ""));
  });

  it("changes with kind, model, credentials, and acp transport", () => {
    expect(definitionHash({ ...def, kind: "codex" })).not.toBe(
      definitionHash(def),
    );
    expect(definitionHash({ ...def, model: "other-model" })).not.toBe(
      definitionHash(def),
    );
    expect(
      definitionHash({
        ...def,
        credentials: { source: "secret", secret: "KEY" },
      }),
    ).not.toBe(definitionHash(def));
    expect(
      definitionHash({ ...def, acp: { command: ["my-agent", "--serve"] } }),
    ).not.toBe(definitionHash(def));
  });

  it("ignores display-only fields (description, name, connections)", () => {
    expect(
      definitionHash({ ...def, description: "Different words" }, "p"),
    ).toBe(definitionHash(def, "p"));
    expect(definitionHash({ ...def, name: "Renamed" }, "p")).toBe(
      definitionHash(def, "p"),
    );
    expect(definitionHash({ ...def, connections: ["linear"] }, "p")).toBe(
      definitionHash(def, "p"),
    );
  });

  it("covers mode (ADR 0056) — widening access re-earns consent; the narrowing knobs don't", () => {
    expect(definitionHash({ ...def, mode: "full-access" })).not.toBe(
      definitionHash(def),
    );
    // Absent mode hashes as the "edit" default, so adding it explicitly
    // does not invalidate standing consent.
    expect(definitionHash({ ...def, mode: "edit" })).toBe(definitionHash(def));
    // Memory and skills stay outside: nothing personal is widened.
    expect(definitionHash({ ...def, memory: true })).toBe(definitionHash(def));
    expect(definitionHash({ ...def, skills: ["publishing-to-github"] })).toBe(
      definitionHash(def),
    );
  });
});
