import type { AgentConfig } from "../agents-store.js";

export type ModelCatalogAgent = Pick<
  AgentConfig,
  "id" | "harness" | "auth" | "apiKey" | "provider"
>;

export interface HarnessModel {
  id: string;
  name: string;
  description?: string;
  /** Versioned model id an alias resolves to (claude-code aliases only). */
  resolvedId?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ("low" | "medium" | "high" | "xhigh" | "max")[];
}

/**
 * Supported models for an agent, resolved live from whatever authority the
 * harness has — never a hardcoded list:
 *  - claude-code: the CLI's own catalog (`supportedModels` via the SDK),
 *    account-aware through the agent's env.
 *  - codex: the installed CLI's app-server `model/list` catalog.
 *  - built-in on Anthropic/OpenAI keys: the provider's public /v1/models.
 *  - built-in on OpenRouter: not handled here — the palette searches the
 *    OpenRouter catalog directly (see `catamorphic:openrouter-models`).
 */
export async function listAgentModels(
  config: ModelCatalogAgent,
  deps: {
    agentHome: (agentId: string) => string;
    harnessExecutable: (
      harness: "claude-code" | "codex",
    ) => Promise<string | null>;
  },
): Promise<HarnessModel[]> {
  // E2E: deterministic stub, no CLIs or network.
  if (process.env.CATAMORPHIC_E2E_FAKE_AGENT === "1") {
    return [
      {
        id: "fake-model-a",
        name: "Fake Model A",
        description: "Stub",
        resolvedId: "fake-model-a-2.1",
      },
      { id: "fake-model-b", name: "Fake Model B", description: "Stub" },
    ];
  }

  const cached = cache.get(config.id);
  const signature = JSON.stringify(config);
  if (
    cached &&
    cached.signature === signature &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return cached.models;
  }
  const active = inFlight.get(config.id);
  if (active?.signature === signature) return active.promise;
  const promise = fetchModels(config, deps)
    .then((models) => {
      cache.set(config.id, { models, signature, fetchedAt: Date.now() });
      return models;
    })
    .finally(() => {
      if (inFlight.get(config.id)?.promise === promise)
        inFlight.delete(config.id);
    });
  inFlight.set(config.id, { signature, promise });
  return promise;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<
  string,
  { models: HarnessModel[]; fetchedAt: number; signature: string }
>();
const inFlight = new Map<
  string,
  { signature: string; promise: Promise<HarnessModel[]> }
>();

async function fetchModels(
  config: ModelCatalogAgent,
  deps: {
    agentHome: (agentId: string) => string;
    harnessExecutable: (
      harness: "claude-code" | "codex",
    ) => Promise<string | null>;
  },
): Promise<HarnessModel[]> {
  switch (config.harness) {
    case "claude-code": {
      const executable = await deps.harnessExecutable("claude-code");
      if (!executable) return [];
      const { listClaudeCodeModels } = await import("@catamorphic/claude-code");
      return listClaudeCodeModels({
        pathToClaudeCodeExecutable: executable,
        env: {
          ...(config.auth === "account"
            ? { CLAUDE_CONFIG_DIR: deps.agentHome(config.id) }
            : {}),
          ...(config.auth === "api-key" && config.apiKey
            ? { ANTHROPIC_API_KEY: config.apiKey }
            : {}),
        },
      });
    }
    case "codex":
      return codexModels(config, deps);
    case "ai-sdk":
      if (config.provider === "anthropic") return anthropicModels(config);
      if (config.provider === "openai") return openaiModels(config);
      return [];
  }
}

async function codexModels(
  config: ModelCatalogAgent,
  deps: {
    agentHome: (agentId: string) => string;
    harnessExecutable: (
      harness: "claude-code" | "codex",
    ) => Promise<string | null>;
  },
): Promise<HarnessModel[]> {
  const binary = await deps.harnessExecutable("codex");
  if (!binary) return [];
  const { listCodexModels } = await import("@catamorphic/codex");
  return listCodexModels({
    executable: binary,
    env: {
      ...(config.auth === "account"
        ? { CODEX_HOME: deps.agentHome(config.id) }
        : {}),
      ...(config.auth === "api-key" && config.apiKey
        ? { CODEX_API_KEY: config.apiKey, OPENAI_API_KEY: config.apiKey }
        : {}),
    },
  });
}

async function anthropicModels(
  config: ModelCatalogAgent,
): Promise<HarnessModel[]> {
  if (!config.apiKey) return [];
  const response = await fetch(
    "https://api.anthropic.com/v1/models?limit=100",
    {
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
    },
  );
  if (!response.ok) throw new Error(`Anthropic models: ${response.status}`);
  const payload = (await response.json()) as {
    data: Array<{ id: string; display_name?: string }>;
  };
  return payload.data.map((model) => ({
    id: model.id,
    name: model.display_name ?? model.id,
  }));
}

async function openaiModels(
  config: ModelCatalogAgent,
): Promise<HarnessModel[]> {
  if (!config.apiKey) return [];
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenAI models: ${response.status}`);
  const payload = (await response.json()) as { data: Array<{ id: string }> };
  return (
    payload.data
      // The listing includes embeddings/audio/etc — keep chat-capable families.
      .filter((model) => /^(gpt-|o\d|chatgpt)/.test(model.id))
      .map((model) => ({ id: model.id, name: model.id }))
  );
}
