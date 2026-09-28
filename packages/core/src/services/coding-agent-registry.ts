import type {
  AgentExecutionTopology,
  CodingAgentProvider,
  McpToolPolicyLayers,
  PersonalLoginKind,
  Sandboxing,
  TurnOptions,
} from "@catamorphic/sandbox";
import type {
  AgentDelegationPolicy,
  AgentEnvironmentPolicy,
  ProjectAgentEntry,
} from "./agent-definitions-service.js";
import type { ConnectionRequirement } from "./connection-types.js";

export interface RegisteredCodingAgent {
  /** Stable registry key persisted on sessions (`agent_sessions.agent_id`). */
  id: string;
  /** How pickers name a host agent; its id when absent. */
  name?: string;
  /** One line for pickers. */
  description?: string;
  provider: CodingAgentProvider;
  topology: AgentExecutionTopology;
  /**
   * What may leave the agent's sandbox (ADR 0176, named in ADR 0182),
   * enforced by core at every boundary: `contained` lets nothing leave,
   * `propose` may propose, `publish` may deploy and publish. Also ranks
   * delegation. Undefined: the host declared none, and nothing is narrowed.
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
   * The Environment alias of the model connection a sandbox-resident
   * harness reaches through the gateway (ADR 0180). Core hands the harness
   * that alias's gateway URL and grant file on every sandbox turn.
   */
  modelConnection?: string;
  /**
   * The harness login this sandbox-resident agent runs with: the chat
   * owner's own (ADR 0184). Core admits it only to Environments that allow
   * personal credentials for that owner, delivers the login into the
   * sandbox on every turn, and hands the harness its location.
   */
  personalLogin?: PersonalLoginKind;
  /** Per-turn defaults applied when the session carries no override. */
  defaults?: TurnOptions;
  /** Committed persona instructions supplied by a project harness factory. */
  systemPrompt?: string;
  /** Explicit source-to-target grants for first-class subsessions. */
  delegation?: AgentDelegationPolicy;
}

/**
 * The host app's roster of configured coding agents. Implementations may be
 * dynamic — the desktop app resolves agents from per-profile config files, so
 * an agent added in Settings is usable without a server restart.
 */
export interface CodingAgentRegistry {
  /**
   * Registry key of the agent used when a session does not name one.
   * Layered when the host supports it (ADR 0056): with a `projectId` the
   * host may answer with the caller's per-project choice or the project's
   * own committed default before falling back to the global default.
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

/**
 * Wrap one sandbox-execution provider as a one-entry registry — the shape
 * hosts with a single flagship agent (and tests) pass to core.
 */
export function singleAgentRegistry(
  provider: CodingAgentProvider,
): CodingAgentRegistry {
  const agent: RegisteredCodingAgent = {
    id: provider.name,
    provider,
    topology: "controller",
  };
  return {
    defaultAgentId: () => agent.id,
    get: (id) => (id === agent.id ? agent : undefined),
    list: () => [agent],
  };
}

export function isCodingAgentRegistry(
  value: CodingAgentProvider | CodingAgentRegistry,
): value is CodingAgentRegistry {
  return typeof (value as CodingAgentRegistry).defaultAgentId === "function";
}
