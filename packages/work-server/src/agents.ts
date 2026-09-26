import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
  ToolPermissionChannel,
} from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { WorkAgentSettings } from "./config.js";
import { FakeEchoAgent } from "./fake-agent.js";

/**
 * The Work server's agent roster: one "assistant" agent backed by the
 * configured model provider (ADR 0160). Anthropic defaults to
 * claude-opus-5; OpenRouter and OpenAI need an explicit model id. Without a
 * provider the server still runs (documents, projects, invites) with chat
 * off; `/me` reports agentSessions accordingly.
 */
export interface AgentSetup {
  registry?: CodingAgentRegistry;
  description: string;
}

export function buildAgentRegistry(deps: {
  sandboxProvider: SandboxProvider;
  toolPermissions: ToolPermissionChannel;
  settings: WorkAgentSettings;
}): AgentSetup {
  const { settings } = deps;
  const effort = settings.effort;

  let resolveModel:
    | ((id: string) => ReturnType<ReturnType<typeof createAnthropic>>)
    | undefined;
  let modelId = settings.model;
  const providerName = settings.provider?.kind;
  if (settings.provider?.kind === "anthropic") {
    const anthropic = createAnthropic({ apiKey: settings.provider.apiKey });
    resolveModel = (id) => anthropic(id);
    modelId ??= "claude-opus-5";
  } else if (settings.provider?.kind === "openrouter") {
    const openrouter = createOpenAI({
      apiKey: settings.provider.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });
    resolveModel = (id) => openrouter(id);
  } else if (settings.provider?.kind === "openai") {
    const openai = createOpenAI({ apiKey: settings.provider.apiKey });
    resolveModel = (id) => openai(id);
  }

  if (settings.fake) {
    return {
      registry: assistantRegistry({
        provider: new FakeEchoAgent(),
        effort,
      }),
      description: "assistant → deterministic fake (WORK_FAKE_AGENT)",
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
      description: `chat OFF — ${providerName} needs WORK_MODEL set to a model id`,
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
      // The Work server supplies a service-owned model. Personal CLI/profile
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
