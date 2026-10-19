import { describe, expect, it } from "vitest";
import { defineModelConnectionProvider } from "./model-connection-provider.js";

describe("model connections (ADRs 0180, 0256)", () => {
  it("serves every path unless it names the ones it serves", () => {
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
    expect(plain.model?.paths).toBeUndefined();
    const paths = ["/chat/completions", "/models"];
    const narrow = defineModelConnectionProvider({
      kind: "openrouter",
      displayName: "OpenRouter",
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      paths,
    });
    expect(narrow.model?.paths).toEqual(paths);
    // Its own copy: a caller changing its array later changes nothing.
    paths.push("/presets");
    expect(narrow.model?.paths).toEqual(["/chat/completions", "/models"]);
  });
});
