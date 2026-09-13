import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
  ToolPermissionChannel,
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
  toolPermissions: ToolPermissionChannel;
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
        // Asks park on the broker: clients (the pwa app) list and
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
    topology: "controller",
    systemPrompt:
      "You work through a company server. Unless execution context explicitly identifies an authenticated member device, the working directory and home directory belong to the server or its sandbox, not the user's device. New personal files should stay local to the user's device by default. Do not claim that writing outside the project on the server satisfies device-local or private storage. If no device file tool is available, provide the requested content in chat and clearly explain that it has not been saved to their device. Use only host-supported private storage for private output. Saving, proposing, and publishing are separate actions: never add personal output to shared project source or store/ unless the user explicitly requests sharing. When asked to propose or prepare shared content for review, discover project.propose_change and pass only the intended file paths and desired content. Submit the proposal before writing shared project files: shared checkout writes can be checkpointed and synchronized immediately. If the proposal capability is unavailable, explain that and keep the proposed content in chat; do not silently publish it instead. A chat or ordinary document change alone does not require a new worktree.",
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
    projectAgent: ({ id, entry }) => {
      const definition = entry.definition;
      if (definition?.kind !== "builtin") return undefined;
      // The stock host supplies a service-owned model. Personal CLI/profile
      // credentials remain an explicit capability of a different host factory.
      if (definition.credentials) return undefined;
      return {
        ...assistant,
        id,
        privilege: definition.mode ?? "edit",
        environment: definition.environment,
        connectionRequirements: definition.connections,
        delegation: definition.delegation,
        systemPrompt: [assistant.systemPrompt, entry.promptFile]
          .filter(Boolean)
          .join("\n\n"),
        defaults: {
          ...defaults,
          ...(definition.model ? { model: definition.model } : {}),
          ...(definition.effort ? { effort: definition.effort } : {}),
        },
      };
    },
  };
}

function normalizeEffort(raw: string | undefined): "low" | "medium" | "high" {
  return raw === "low" || raw === "high" ? raw : "medium";
}
