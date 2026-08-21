import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
  ToolPermissionBroker,
} from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { FakeEchoAgent } from "./fake-agent.js";

/**
 * The stock server's agent roster: one "assistant" agent, configured from
 * env. Which provider backs it follows the first key present:
 *
 *   ANTHROPIC_API_KEY   → Anthropic (default model claude-opus-5)
 *   OPENROUTER_API_KEY  → OpenRouter (CATAMORPHIC_MODEL required)
 *   OPENAI_API_KEY      → OpenAI     (CATAMORPHIC_MODEL required)
 *
 * CATAMORPHIC_MODEL overrides the model id; CATAMORPHIC_EFFORT the effort.
 * No key → the server still runs (documents, projects, invites) with chat
 * off; `/me` reports agentSessions accordingly.
 */
export interface AgentSetup {
  registry?: CodingAgentRegistry;
  description: string;
}

export function buildAgentRegistry(deps: {
  sandboxProvider: SandboxProvider;
  toolPermissions: ToolPermissionBroker;
  env?: Record<string, string | undefined>;
}): AgentSetup {
  const env = deps.env ?? process.env;
  const effort = normalizeEffort(env.CATAMORPHIC_EFFORT);

  let resolveModel:
    | ((id: string) => ReturnType<ReturnType<typeof createAnthropic>>)
    | undefined;
  let modelId = env.CATAMORPHIC_MODEL;
  let providerName: string | undefined;
  if (env.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    resolveModel = (id) => anthropic(id);
    modelId ??= "claude-opus-5";
    providerName = "anthropic";
  } else if (env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
    resolveModel = (id) => openrouter(id);
    providerName = "openrouter";
  } else if (env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    resolveModel = (id) => openai(id);
    providerName = "openai";
  }

  if (env.CATAMORPHIC_FAKE_AGENT === "1") {
    return {
      registry: assistantRegistry({
        provider: new FakeEchoAgent(),
        effort,
      }),
      description: "assistant → deterministic fake (CATAMORPHIC_FAKE_AGENT)",
    };
  }
  if (!resolveModel || !providerName) {
    return {
      description:
        "chat OFF — set ANTHROPIC_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY) to enable the assistant",
    };
  }
  if (!modelId) {
    return {
      description: `chat OFF — ${providerName} needs CATAMORPHIC_MODEL set to a model id`,
    };
  }

  return {
    registry: assistantRegistry({
      provider: new AiSdkCodingAgent({
        model: resolveModel(modelId),
        sandboxProvider: deps.sandboxProvider,
        resolveModel,
        effort,
        // Asks park on the broker: clients (the companion app) list and
        // answer them over the permissions routes (ADR 0054).
        onToolPermission: deps.toolPermissions.handlerFor("Assistant"),
      }),
      effort,
      modelId,
    }),
    description: `assistant → ${providerName}/${modelId} (effort ${effort})`,
  };
}

export const ASSISTANT_SLUG = "assistant";

/** The registry id a scoped member's role ref resolves to (ADR 0055). */
export function projectAssistantId(projectId: string): string {
  return `project:${projectId}:${ASSISTANT_SLUG}`;
}

/**
 * One provider, addressable two ways: bare "assistant" (root callers,
 * default), and `project:<id>:assistant` — the id a member's role ref
 * (`agents: ["assistant"]`) maps to. Scoped session-access checks compare
 * against the project-qualified form, so the registry must serve it.
 */
function assistantRegistry(config: {
  provider: RegisteredCodingAgent["provider"];
  effort: "low" | "medium" | "high";
  modelId?: string;
}): CodingAgentRegistry {
  const defaults = {
    effort: config.effort,
    ...(config.modelId ? { model: config.modelId } : {}),
  };
  const assistant: RegisteredCodingAgent = {
    id: ASSISTANT_SLUG,
    provider: config.provider,
    execution: "sandbox",
    defaults,
  };
  const projectForm = /^project:[0-9a-f-]+:assistant$/;
  return {
    defaultAgentId: (projectId) =>
      projectId ? projectAssistantId(projectId) : ASSISTANT_SLUG,
    get: (id) => {
      if (id === ASSISTANT_SLUG) return assistant;
      if (projectForm.test(id)) return { ...assistant, id };
      return undefined;
    },
    list: () => [assistant],
  };
}

function normalizeEffort(raw: string | undefined): "low" | "medium" | "high" {
  return raw === "low" || raw === "high" ? raw : "medium";
}
