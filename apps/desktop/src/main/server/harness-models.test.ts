import { afterEach, describe, expect, it, vi } from "vitest";
import { listAgentModels, type ModelCatalogAgent } from "./harness-models.js";

const deps = {
  agentHome: (id: string) => `/homes/${id}`,
  harnessExecutable: async () => null,
};
const agent = (
  id: string,
  provider: "anthropic" | "openai",
): ModelCatalogAgent => ({
  id,
  harness: "ai-sdk",
  provider,
  auth: "api-key",
  apiKey: "test-key",
});
const respond = (data: unknown[]) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data }))),
  );

afterEach(() => vi.unstubAllGlobals());

describe("provider model catalogs", () => {
  it("keeps Anthropic's display names and makes none up", async () => {
    respond([
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
      { id: "claude-unnamed" },
    ]);
    await expect(
      listAgentModels(agent("anthropic-names", "anthropic"), deps),
    ).resolves.toEqual([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-unnamed" },
    ]);
  });

  it("lists OpenAI's chat models by id alone, since it names none", async () => {
    respond([{ id: "gpt-5.5" }, { id: "text-embedding-3-large" }]);
    await expect(
      listAgentModels(agent("openai-ids", "openai"), deps),
    ).resolves.toEqual([{ id: "gpt-5.5" }]);
  });
});
