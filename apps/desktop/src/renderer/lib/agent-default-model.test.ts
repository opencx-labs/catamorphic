// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  defaultModelLabel,
  modelId,
  sameModel,
} from "./agent-default-model.js";
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
  it("names the model by the id the harness sends", () => {
    expect(
      defaultModelLabel(claude, { id: "claude-sonnet-5", name: "Sonnet" }),
    ).toBe("claude-sonnet-5");
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

describe("modelId", () => {
  const catalog = [
    { id: "opus[1m]", resolvedId: "claude-opus-5[1m]" },
    { id: "claude-fable-5-1[1m]", resolvedId: "claude-fable-5-1" },
    { id: "gpt-5.5" },
  ];
  it("resolves an alias to the id it sends", () => {
    expect(modelId("opus[1m]", catalog)).toBe("claude-opus-5[1m]");
  });
  it("keeps the context window of an id that already names the model", () => {
    expect(modelId("claude-fable-5-1[1m]", catalog)).toBe(
      "claude-fable-5-1[1m]",
    );
  });
  it("keeps ids the catalog does not resolve", () => {
    expect(modelId("gpt-5.5", catalog)).toBe("gpt-5.5");
    expect(modelId("claude-fable-5-1", catalog)).toBe("claude-fable-5-1");
    expect(modelId("opus", undefined)).toBe("opus");
  });
});
