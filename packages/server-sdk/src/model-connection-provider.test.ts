import type { ModelRequest } from "@catamorphic/core";
import { describe, expect, it } from "vitest";
import { defineModelConnectionProvider } from "./model-connection-provider.js";

const request = (body: ModelRequest["body"]): ModelRequest => ({
  method: "POST",
  path: "chat/completions",
  body,
  context: {
    tenantId: "tenant",
    projectId: "project",
    alias: "models",
    sessionId: "session",
  },
});

describe("model connection rewrites (ADR 0256)", () => {
  it("has none unless the provider asks for one", () => {
    const plain = defineModelConnectionProvider({
      kind: "openrouter",
      displayName: "OpenRouter",
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(plain.model?.rewrite).toBeUndefined();
  });

  it("replaces each overridden field whole, and removes one set to null", async () => {
    const pinned = defineModelConnectionProvider({
      kind: "openrouter",
      displayName: "OpenRouter",
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      override: {
        provider: { only: ["together"], allow_fallbacks: false },
        models: null,
      },
    });
    const body = await pinned.model?.rewrite?.(
      request({
        model: "deepseek/v4-flash",
        provider: { order: ["elsewhere"], data_collection: "allow" },
        models: ["openai/gpt-x"],
      }),
    );
    expect(body).toEqual({
      model: "deepseek/v4-flash",
      provider: { only: ["together"], allow_fallbacks: false },
    });
  });

  it("runs the host's rewrite first, then the overrides", async () => {
    const seen: ModelRequest[] = [];
    const provider = defineModelConnectionProvider({
      kind: "openrouter",
      displayName: "OpenRouter",
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      rewrite: async (call) => {
        seen.push(call);
        return { ...call.body, provider: { only: ["parasail"] }, user: "x" };
      },
      override: { user: null },
    });
    const body = await provider.model?.rewrite?.(request({ model: "m" }));
    expect(body).toEqual({ model: "m", provider: { only: ["parasail"] } });
    expect(seen[0]?.context).toMatchObject({ alias: "models" });
  });
});
