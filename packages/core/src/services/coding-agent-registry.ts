import type { JsonObject } from "@catamorphic/agent-protocol";
import type { HarnessAdapter } from "@catamorphic/agent-protocol/runner";
import type {
  AgentEffort,
  AgentExecutionTopology,
  AgentMcpServerConfig,
  AgentPluginConfig,
  ExtraTool,
  ExtraToolContext,
  HarnessPermissions,
  McpToolPolicyLayers,
  Sandboxing,
  SignInHarness,
  ToolPolicyAnnotations,
  TurnContextFragment,
} from "@catamorphic/sandbox";
import type {
  AgentDelegationPolicy,
  AgentEnvironmentPolicy,
  ProjectAgentEntry,
} from "./agent-definitions-service.js";
import type { ConnectionRequirement } from "./connection-types.js";

/** What a host hook knows about the turn it serves. */
export interface AgentTurnContext extends ExtraToolContext {
  /** The turn the hook serves. */
  turnId: string;
}

/**
 * The harness an agent runs on and where its runner runs (ADR 0198).
 * `host`: an adapter in this process, beside a checkout on this machine or
 * driving a sandbox through its tools (the desktop's harnesses, the
 * built-in agent). `sandbox`: the runner bundle inside the session's
 * sandbox, where the harness's CLI is.
 */
export type AgentHarness =
  | {
      placement: "host";
      adapter: HarnessAdapter;
      /** Host objects the adapter needs (never serialized). */
      local?: (context: AgentTurnContext) => Record<string, unknown>;
      /** Environment of the harness process: the host's own settings (CLAUDE_CONFIG_DIR). */
      env?: Record<string, string>;
      /** Tools this host serves the agent beside Work's capability tools. */
      hostTools?: readonly ExtraTool[];
      /** MCP servers this host adds, read at every turn so rotated tokens apply. */
      mcpServers?: (
        context: AgentTurnContext,
      ) => Record<string, AgentMcpServerConfig>;
      /** The host's own policy layers per server, read live (ADR 0054). */
      toolPolicies?: () => Record<string, McpToolPolicyLayers>;
      toolAnnotations?: () => Record<
        string,
        Record<string, ToolPolicyAnnotations>
      >;
      plugins?: readonly AgentPluginConfig[];
      /** Facts for this turn, beside the person's message (ADR 0152). */
      context?: (context: AgentTurnContext) => Promise<TurnContextFragment[]>;
      /** Standing instructions this host adds (a playbook, a persona). */
      instructions?: string;
    }
  | {
      placement: "sandbox";
      /** The bundled adapter, e.g. `claude-code`, `codex`. */
      id: string;
    };

export interface RegisteredCodingAgent {
  /** Stable registry key persisted on sessions (`agent_sessions.agent_id`). */
  id: string;
  /** How pickers name a host agent; its id when absent. */
  name?: string;
  /** One line for pickers. */
  description?: string;
  harness: AgentHarness;
  /**
   * `native`: the agent works in a checkout on this machine (the desktop).
   * `controller`: it works in the session's sandbox.
   */
  topology: AgentExecutionTopology;
  /** Settings handed to the harness on every attempt (`AttemptStart.options`). */
  options?: JsonObject;
  /**
   * What may leave the agent's sandbox (ADR 0176, named in ADR 0182),
   * enforced by core at every boundary.
   */
  sandboxing?: Sandboxing;
  /**
   * The agent's own tool-policy narrowing by server key (ADR 0054 agent
   * scope), layered with the caller's role policies on every turn.
   */
  toolPolicies?: Readonly<Record<string, McpToolPolicyLayers>>;
  /** Additional compatibility requirements for profile-defined agents. */
  environment?: AgentEnvironmentPolicy;
  /** Brokered connection aliases required before this agent can start. */
  connectionRequirements?: readonly (string | ConnectionRequirement)[];
  /**
   * The Environment alias of the model connection a sandbox harness
   * reaches through the gateway (ADR 0180).
   */
  modelConnection?: string;
  /**
   * The harness runs on the chat owner's own sign-in, made on the machine
   * that runs it (ADR 0199). Placement takes only machines that report it.
   */
  signIn?: SignInHarness;
  /** Per-turn defaults applied when the session carries no override. */
  defaults?: {
    model?: string;
    effort?: AgentEffort;
    harnessPermissions?: HarnessPermissions;
  };
  /** Committed persona instructions supplied by a project harness factory. */
  systemPrompt?: string;
  /** Explicit source-to-target grants for first-class subsessions. */
  delegation?: AgentDelegationPolicy;
  /**
   * What a turn whose machine stopped does (ADR 0198): `continue` queues a
   * continuation when the native thread can resume exactly; `stop` leaves
   * it interrupted. Default `continue`.
   */
  recovery?: "continue" | "stop";
}

/** The harness id an agent runs on. */
export function harnessIdOf(
  agent: Pick<RegisteredCodingAgent, "harness">,
): string {
  return agent.harness.placement === "host"
    ? agent.harness.adapter.id
    : agent.harness.id;
}

/**
 * The host app's roster of configured coding agents. Implementations may be
 * dynamic: the desktop app resolves agents from per-profile config files, so
 * an agent added in Settings is usable without a server restart.
 */
export interface CodingAgentRegistry {
  /**
   * Registry key of the agent used when a session does not name one.
   * Layered when the host supports it (ADR 0056).
   */
  defaultAgentId(projectId?: string): string | undefined;
  get(id: string): RegisteredCodingAgent | undefined;
  list(): RegisteredCodingAgent[];
  /** Host harness factory. Core loads the committed definition and checks access. */
  projectAgent?(args: {
    id: string;
    entry: ProjectAgentEntry;
  }):
    | Promise<RegisteredCodingAgent | undefined>
    | RegisteredCodingAgent
    | undefined;
}

/** Wrap one agent as a one-entry registry: hosts with a single agent, and tests. */
export function singleAgentRegistry(
  agent: RegisteredCodingAgent,
): CodingAgentRegistry {
  return {
    defaultAgentId: () => agent.id,
    get: (id) => (id === agent.id ? agent : undefined),
    list: () => [agent],
  };
}

export function isCodingAgentRegistry(
  value: RegisteredCodingAgent | CodingAgentRegistry,
): value is CodingAgentRegistry {
  return typeof (value as CodingAgentRegistry).defaultAgentId === "function";
}
