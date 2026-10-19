import { describe, expect, it } from "vitest";
import { defineModelConnectionProvider } from "./model-connection-provider.js";

describe("model connections (ADRs 0180, 0256)", () => {
  it("carries no override or paths unless it names them", () => {
    const plain = defineModelConnectionProvider({
      kind: "openrouter",
      displayName: "OpenRouter",
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(plain.model).toMatchObject({
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(plain.model?.override).toBeUndefined();
    expect(plain.model?.paths).toBeUndefined();
  });

  it("carries the fields it sets on every request and the paths it serves", () => {
    const override = {
      provider: { only: ["provider-a"], allow_fallbacks: false },
      models: null,
    };
    const paths = ["/chat/completions", "/models"];
    const pinned = defineModelConnectionProvider({
      kind: "openrouter",
      displayName: "OpenRouter",
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      override,
      paths,
    });
    expect(pinned.model?.override).toEqual(override);
    expect(pinned.model?.paths).toEqual(paths);
    // Its own copies: a caller changing its object later changes nothing.
    paths.push("/presets");
    expect(pinned.model?.paths).toEqual(["/chat/completions", "/models"]);
  });
});
