// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  defaultModelLabel,
  modelId,
  modelLabel,
  modelSearchText,
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

describe("modelLabel", () => {
  const catalog = [
    {
      id: "default",
      name: "Default (recommended)",
      resolvedId: "claude-opus-5",
    },
    { id: "sonnet", name: "Sonnet", resolvedId: "claude-sonnet-5" },
    { id: "haiku", resolvedId: "claude-haiku-5" },
    { id: "gpt-5.5-codex", name: "gpt-5.5-codex" },
    { id: "gpt-5.5" },
  ];
  const label = (id: string) =>
    modelLabel(catalog.find((model) => model.id === id) ?? { id }, catalog);
  it("titles a model by its display name, the id it sends beside it", () => {
    expect(label("sonnet")).toEqual({
      title: "Sonnet",
      detail: "claude-sonnet-5",
    });
    expect(label("default")).toEqual({
      title: "Default (recommended)",
      detail: "claude-opus-5",
    });
    expect(
      modelLabel({ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }),
    ).toEqual({
      title: "Claude Sonnet 5",
      detail: "anthropic/claude-sonnet-5",
    });
  });
  it("titles a model without a name of its own by its id, once", () => {
    expect(label("gpt-5.5")).toEqual({ title: "gpt-5.5" });
    expect(label("gpt-5.5-codex")).toEqual({ title: "gpt-5.5-codex" });
    expect(modelLabel({ id: "gpt-5.5", name: "GPT-5.5" })).toEqual({
      title: "gpt-5.5",
    });
    expect(modelLabel({ id: "sonnet", name: "Sonnet" })).toEqual({
      title: "sonnet",
    });
    expect(modelLabel({ id: "custom", name: "  " })).toEqual({
      title: "custom",
    });
  });
  it("keeps the versioned id beside an unnamed alias", () => {
    expect(label("haiku")).toEqual({
      title: "haiku",
      detail: "claude-haiku-5",
    });
  });
});

describe("modelSearchText", () => {
  it("matches a model by its name and every id it shows", () => {
    expect(
      modelSearchText({
        id: "sonnet",
        name: "Sonnet",
        resolvedId: "claude-sonnet-5",
      }),
    ).toBe("Sonnet sonnet claude-sonnet-5");
    expect(modelSearchText({ id: "gpt-5.5" })).toBe("gpt-5.5");
  });
});
