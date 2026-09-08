import { describe, expect, it } from "vitest";
import { effectiveEffort, supportedEfforts } from "./agent-effort.js";

describe("harness effort controls", () => {
  it("preserves max supported by the shipped Codex SDK", () => {
    expect(effectiveEffort({ harness: "codex" }, "max")).toBe("max");
    expect(supportedEfforts({ harness: "codex" })).toContain("max");
  });
  it("reflects the built-in OpenAI adapter's high ceiling", () => {
    expect(
      effectiveEffort({ harness: "ai-sdk", provider: "openai" }, "xhigh"),
    ).toBe("high");
  });
  it("does not advertise an unverified OpenRouter reasoning control", () => {
    expect(
      supportedEfforts({ harness: "ai-sdk", provider: "openrouter" }),
    ).toEqual([]);
    expect(
      effectiveEffort({ harness: "ai-sdk", provider: "openrouter" }, "high"),
    ).toBeNull();
  });
  it("preserves the Claude adapter's full scale", () => {
    expect(effectiveEffort({ harness: "claude-code" }, "max")).toBe("max");
  });
  it("honors model-specific restrictions supplied by the harness", () => {
    const model = { id: "limited", name: "Limited", supportsEffort: false };
    expect(supportedEfforts({ harness: "claude-code" }, model)).toEqual([]);
    expect(
      effectiveEffort({ harness: "claude-code" }, "max", {
        ...model,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      }),
    ).toBe("high");
  });
});
