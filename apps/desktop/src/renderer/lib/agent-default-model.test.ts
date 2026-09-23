// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { defaultModelLabel, sameModel } from "./agent-default-model.js";
import type { AgentInfo } from "./desktop-api.js";

describe("sameModel", () => {
  it("treats a context-window suffix as the same model", () => {
    expect(sameModel("claude-opus-5[1m]", "claude-opus-5")).toBe(true);
    expect(sameModel("claude-opus-5", "claude-opus-5")).toBe(true);
  });
  it("keeps different models and missing ids apart", () => {
    expect(sameModel("claude-opus-5", "claude-sonnet-5")).toBe(false);
    expect(sameModel("sonnet", "claude-sonnet-5")).toBe(false);
    expect(sameModel(null, "claude-sonnet-5")).toBe(false);
    expect(sameModel(undefined, undefined)).toBe(false);
  });
});

describe("defaultModelLabel", () => {
  const claude: Pick<AgentInfo, "id" | "harness" | "provider"> = {
    id: "a",
    harness: "claude-code",
    provider: "anthropic",
  };
  it("prefers the harness's name, then its id", () => {
    expect(
      defaultModelLabel(claude, { id: "claude-sonnet-5", name: "Sonnet" }),
    ).toBe("Sonnet");
    expect(defaultModelLabel(claude, { id: "custom" })).toBe("custom");
  });
  it("names who decides when the harness cannot say", () => {
    expect(defaultModelLabel(claude, null)).toBe("Claude Code default");
    expect(defaultModelLabel({ ...claude, harness: "codex" }, null)).toBe(
      "Codex default",
    );
    expect(
      defaultModelLabel(
        { ...claude, harness: "ai-sdk", provider: "openrouter" },
        null,
      ),
    ).toBe("Best free model");
    expect(defaultModelLabel(undefined, null)).toBe("Agent default");
  });
});
