import type {
  AgentExecutionTopology,
  CodingAgentProvider,
  TurnOptions,
} from "@catamorphic/sandbox";
import type { AgentEnvironmentPolicy } from "./agent-definitions-service.js";
import type { ConnectionRequirement } from "./connection-types.js";

export interface RegisteredCodingAgent {
  /** Stable registry key persisted on sessions (`agent_sessions.agent_id`). */
  id: string;
  provider: CodingAgentProvider;
  topology: AgentExecutionTopology;
  /** Additional compatibility requirements for profile-defined agents. */
  environment?: AgentEnvironmentPolicy;
  /** Brokered connection aliases required before this agent can start. */
  connectionRequirements?: readonly (string | ConnectionRequirement)[];
  /** Per-turn defaults applied when the session carries no override. */
  defaults?: TurnOptions;
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
}

/**
 * Wrap one sandbox-execution provider as a one-entry registry — the shape
 * hosts with a single flagship agent (playground, tests) pass to core.
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
