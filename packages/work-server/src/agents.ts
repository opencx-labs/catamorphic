import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createAiSdkAdapter } from "@catamorphic/ai-sdk";
import {
  type AgentDefinition,
  type AgentHarness,
  type CodingAgentRegistry,
  normalizeConnectionRequirement,
  type RegisteredCodingAgent,
} from "@catamorphic/core";
import {
  SIGN_IN_HARNESSES,
  type SignInHarness,
  signInHarness,
} from "@catamorphic/sandbox";
import type { WorkAgentSettings } from "./config.js";
import { createFakeAgentAdapter } from "./fake-agent.js";

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
        harness: { placement: "host", adapter: createFakeAgentAdapter() },
        effort,
      }),
      description: "assistant → deterministic fake (WORK_FAKE_AGENT)",
    };
  }
  // Without an organization model the assistant is off, but members can
  // still chat with Claude Code and Codex on their own sign-ins on a
  // machine of their own they signed in on (ADRs 0199, 0213, 0342).
  if (!resolveModel || !providerName) {
    return {
      registry: assistantRegistry({ effort }),
      description:
        "assistant off (set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY); Claude Code and Codex on members' own sign-ins",
    };
  }
  if (!modelId) {
    return {
      registry: assistantRegistry({ effort }),
      description: `assistant off (${providerName} needs WORK_MODEL set to a model id); Claude Code and Codex on members' own sign-ins`,
    };
  }

  return {
    registry: assistantRegistry({
      // The built-in agent runs on the control plane (ADR 0198); its file
      // and shell tools act on the chat's sandbox.
      harness: {
        placement: "host",
        adapter: createAiSdkAdapter({
          model: resolveModel(modelId),
          resolveModel,
          effort,
        }),
      },
      effort,
      modelId,
    }),
    description: `assistant → ${providerName}/${modelId} (effort ${effort})`,
  };
}

export const ASSISTANT_SLUG = "assistant";

/**
 * Claude Code and Codex on the chat owner's own sign-in, made on the
 * machine that runs the chat (ADR 0199). Offered in projects with an
 * Environment that allows personal credentials; a chat places only on a
 * machine of the owner's that reports their sign-in (ADRs 0213, 0342).
 */
export const SIGN_IN_AGENTS: Readonly<
  Record<SignInHarness, { name: string; description: string }>
> = {
  "claude-code": {
    name: "Claude Code",
    description: "Claude Code on your own Claude sign-in on the machine",
  },
  codex: {
    name: "Codex",
    description: "Codex on your own ChatGPT sign-in on the machine",
  },
};

/** The registry id a scoped member's role ref resolves to (ADR 0055). */
export function projectAssistantId(projectId: string): string {
  return `project:${projectId}:${ASSISTANT_SLUG}`;
}

const SYSTEM_PROMPT =
  "You work through a company server. Unless execution context explicitly identifies an authenticated member device, the working directory and home directory belong to the server or its sandbox, not the user's device. New personal files should stay local to the user's device by default. Do not claim that writing outside the project on the server satisfies device-local or private storage. If no device file tool is available, provide the requested content in chat and clearly explain that it has not been saved to their device. Use only host-supported private storage for private output. Saving, proposing, and publishing are separate actions: never add personal output to shared project source or store/ unless the user explicitly requests sharing. Your project folder is a Git checkout that is this chat's alone: a branch of its own, starting from the default branch of the project's repository (or the ref this chat was given). Nothing you write there reaches the shared project by itself. Work saves the branch you are on with its commits, and your uncommitted changes, and gives them back when the workspace returns; other local branches, ignored files, a rebase in progress and anything outside the project folder are not kept, so commit what matters on your current branch. When asked to propose or prepare shared content for review, commit it and discover project.create_pull_request: it pushes your commits as this chat's own branch and opens a pull request, or updates the one this chat already opened, and records it on the chat. If that capability is unavailable or the project has no repository, explain that and keep the work on your branch; do not silently publish it instead. A chat or ordinary document change alone does not require a new worktree.";

/**
 * Claude Code and Codex on the server (ADRs 0180, 0198): the runner bundle
 * runs each inside the chat's sandbox, on a worker or the control plane,
 * where its CLI is. Model and effort travel as turn defaults.
 */
function sandboxHarness(kind: "claude-code" | "codex"): {
  harness: AgentHarness;
  options: RegisteredCodingAgent["options"];
} {
  return kind === "codex"
    ? { harness: { placement: "sandbox", id: "codex" }, options: {} }
    : {
        harness: { placement: "sandbox", id: "claude-code" },
        // The sandbox is the boundary: edits and commands run without
        // prompts, and sandboxing is enforced where changes leave it (ADR
        // 0182). A definition's own permission mode travels per turn.
        options: { permissionMode: "acceptEdits", memory: false },
      };
}

/**
 * One assistant, addressable two ways: bare "assistant" (root callers,
 * default), and `project:<id>:assistant`, the id a member's role ref
 * (`agents: ["assistant"]`) maps to. Scoped session-access checks compare
 * against the project-qualified form, so the registry must serve it.
 */
function assistantRegistry(config: {
  /** The organization model's assistant; absent without an org model. */
  harness?: AgentHarness;
  effort: "low" | "medium" | "high";
  modelId?: string;
}): CodingAgentRegistry {
  const defaults = {
    effort: config.effort,
    ...(config.modelId ? { model: config.modelId } : {}),
  };
  const assistant: RegisteredCodingAgent | undefined = config.harness && {
    id: ASSISTANT_SLUG,
    harness: config.harness,
    topology: "controller",
    systemPrompt: SYSTEM_PROMPT,
    defaults,
  };
  const projectForm = /^project:[0-9a-f-]+:assistant$/;
  // Claude Code and Codex on the member's own sign-in (ADRs 0199, 0342).
  const signInAgent = (kind: SignInHarness): RegisteredCodingAgent => ({
    id: kind,
    name: SIGN_IN_AGENTS[kind].name,
    description: SIGN_IN_AGENTS[kind].description,
    ...sandboxHarness(kind),
    topology: "controller",
    sandboxing: "propose",
    signIn: kind,
    systemPrompt: SYSTEM_PROMPT,
  });
  const signInAgents = SIGN_IN_HARNESSES.map(signInAgent);
  const signInForm = /^project:[0-9a-f-]+:(claude-code|codex)$/;
  return {
    // Without an org model, a chat starts on the member's own Codex.
    defaultAgentId: (projectId) =>
      assistant
        ? projectId
          ? projectAssistantId(projectId)
          : ASSISTANT_SLUG
        : projectId
          ? `project:${projectId}:codex`
          : "codex",
    get: (id) => {
      if (assistant && id === ASSISTANT_SLUG) return assistant;
      if (assistant && projectForm.test(id)) return { ...assistant, id };
      const bare = signInAgents.find((agent) => agent.id === id);
      if (bare) return bare;
      const qualified = id.match(signInForm)?.[1];
      const agent = signInAgents.find((entry) => entry.id === qualified);
      return agent ? { ...agent, id } : undefined;
    },
    list: () => (assistant ? [assistant, ...signInAgents] : signInAgents),
    projectAgent: ({ id, entry }) => {
      const definition = entry.definition;
      if (
        definition &&
        (definition.kind === "claude-code" ||
          definition.kind === "codex" ||
          definition.kind === "acp")
      )
        return sandboxProjectAgent({
          id,
          definition,
          promptFile: entry.promptFile,
        });
      if (definition?.kind !== "builtin" || !assistant) return undefined;
      // The Work server supplies a service-owned model. Personal CLI/profile
      // credentials remain an explicit capability of a different host factory.
      if (definition.credentials) return undefined;
      return {
        ...assistant,
        id,
        sandboxing: definition.sandboxing ?? "propose",
        environment: definition.environment,
        connectionRequirements: definition.connections,
        delegation: definition.delegation,
        systemPrompt: [SYSTEM_PROMPT, entry.promptFile]
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

/**
 * A committed agent whose harness runs in its chat's sandbox (ADRs 0180,
 * 0198): `claude-code`, `codex`, or an ACP agent's own command (ADR 0255).
 * Served when its credentials name a model connection of its Environment,
 * or, for Claude Code and Codex, `personal`: the chat owner's own sign-in
 * on a machine of theirs (ADRs 0199, 0213, 0342).
 * An ACP agent runs only on a model connection: on a server it has no
 * sign-in of its own, and its command comes from the Environment's image.
 */
function sandboxProjectAgent(input: {
  id: string;
  definition: AgentDefinition;
  promptFile: string | undefined;
}): RegisteredCodingAgent | undefined {
  const { definition } = input;
  const requirements = (definition.connections ?? []).map(
    normalizeConnectionRequirement,
  );
  const command = definition.acp?.command;
  const harness =
    definition.kind === "acp"
      ? command?.[0]
        ? acpHarness({
            id: input.id,
            command,
            shell: definition.acp?.shell === true,
            projectConfig: definition.acp?.projectConfig,
            env: definition.acp?.env,
          })
        : undefined
      : sandboxHarness(definition.kind === "codex" ? "codex" : "claude-code");
  if (!harness) return undefined;
  const common = {
    id: input.id,
    ...harness,
    topology: "controller" as const,
    sandboxing: definition.sandboxing ?? "propose",
    environment: definition.environment,
    delegation: definition.delegation,
    systemPrompt: [SYSTEM_PROMPT, input.promptFile]
      .filter(Boolean)
      .join("\n\n"),
    defaults: {
      ...(definition.model ? { model: definition.model } : {}),
      ...(definition.effort ? { effort: definition.effort } : {}),
    },
  };
  if (definition.credentials?.source === "personal") {
    const signIn = signInHarness(definition.kind);
    return signIn
      ? { ...common, connectionRequirements: requirements, signIn }
      : undefined;
  }
  const alias =
    definition.credentials?.source === "connection"
      ? definition.credentials.connection
      : undefined;
  if (!alias) return undefined;
  return {
    ...common,
    // The model connection is required like any binding the agent uses.
    connectionRequirements: requirements.some(
      (requirement) => requirement.alias === alias,
    )
      ? requirements
      : [...requirements, { alias }],
    modelConnection: alias,
  };
}

/**
 * An ACP agent's command in its chat's sandbox (ADR 0255): the bundled ACP
 * adapter, under a harness of its own so a chat stays with its agent. The
 * sandbox is the boundary, so the command needs no member's approval here.
 */
function acpHarness(input: {
  id: string;
  command: readonly string[];
  /** It runs its commands with `$SHELL` (ADR 0332). */
  shell: boolean;
  /** `false`: it loads nothing from the checkout (ADR 0332). */
  projectConfig: boolean | undefined;
  env: Record<string, string> | undefined;
}): {
  harness: AgentHarness;
  options: RegisteredCodingAgent["options"];
} {
  return {
    harness: { placement: "sandbox", id: `acp:${input.id}` },
    options: {
      command: [...input.command],
      ...(input.shell ? { shell: true } : {}),
      ...(input.projectConfig !== undefined
        ? { projectConfig: input.projectConfig }
        : {}),
      ...(input.env ? { env: { ...input.env } } : {}),
    },
  };
}
