import type { AgentEffort } from "@catamorphic/sandbox";
import {
  type AgentDelegationGrant,
  type AgentDelegationPolicy,
  formatProjectAgentId,
} from "./agent-definitions-service.js";
import type { AgentModelChoice } from "./coding-agent-registry.js";

/**
 * Who an agent may start as a subsession, and what it may choose for them
 * (ADR 0270). Grants are matched here, apart from sessions, so the rules
 * read in one place.
 */

/** No `delegation`: copies of yourself, on any model and effort. */
export const DEFAULT_DELEGATION_POLICY: AgentDelegationPolicy = {
  enabled: true,
  maxConcurrentChildren: 10,
  agents: [{ agent: "self", model: "any", effort: "any", delegate: true }],
};

export function delegationPolicy(
  policy: AgentDelegationPolicy | undefined,
): AgentDelegationPolicy {
  return policy ?? DEFAULT_DELEGATION_POLICY;
}

const EFFORTS: readonly AgentEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** What a parent asks for: whom to start and with what. */
export interface DelegationRequest {
  targetAgentId: string;
  sourceAgentId: string;
  projectId: string;
  /** Requested, not inherited: only a choice is a grant's business. */
  model?: string;
  effort?: AgentEffort;
  /** The parent chat's effort now, for `at-most-parent`. */
  parentEffort?: AgentEffort;
  /** A wildcard grant admits the target: its sandboxing is no wider. */
  wildcardAdmits: boolean;
}

/** A grant's agent as an id, with `project:<slug>` made absolute. */
export function grantAgentId(
  grant: Pick<AgentDelegationGrant, "agent">,
  projectId: string,
): string {
  const relative = grant.agent.match(/^project:([^:]+)$/);
  return relative
    ? formatProjectAgentId(projectId, relative[1] ?? "")
    : grant.agent;
}

function admits(
  grant: AgentDelegationGrant,
  request: DelegationRequest,
): boolean {
  if (grant.agent === "self")
    return request.targetAgentId === request.sourceAgentId;
  if (grant.agent === "*") return request.wildcardAdmits;
  return grantAgentId(grant, request.projectId) === request.targetAgentId;
}

/** Why `grant` refuses the requested settings, or null when it takes them. */
function settingsRefusal(
  grant: AgentDelegationGrant,
  request: DelegationRequest,
): string | null {
  if (request.model !== undefined) {
    if (grant.model === "fixed") return "its model is fixed";
    if (Array.isArray(grant.model) && !grant.model.includes(request.model))
      return `its model is one of ${grant.model.join(", ")}`;
  }
  if (request.effort !== undefined) {
    if (grant.effort === "fixed") return "its effort is fixed";
    if (grant.effort === "at-most-parent") {
      if (!request.parentEffort)
        return "its effort can be no higher than this chat's, which is the harness default";
      if (
        EFFORTS.indexOf(request.effort) > EFFORTS.indexOf(request.parentEffort)
      )
        return `its effort is at most this chat's, ${request.parentEffort}`;
    }
    if (Array.isArray(grant.effort) && !grant.effort.includes(request.effort))
      return `its effort is one of ${grant.effort.join(", ")}`;
  }
  return null;
}

/**
 * The first grant that admits the target and takes the requested settings,
 * or why none does. A refusal says what is allowed instead.
 */
export function chooseGrant(
  policy: AgentDelegationPolicy,
  request: DelegationRequest,
): { grant: AgentDelegationGrant } | { refusal: string } {
  const admitting = policy.agents.filter((grant) => admits(grant, request));
  const who =
    request.targetAgentId === request.sourceAgentId
      ? "a copy of yourself"
      : `agent ${request.targetAgentId}`;
  if (admitting.length === 0) return { refusal: `You may not start ${who}.` };
  const reasons: string[] = [];
  for (const grant of admitting) {
    const reason = settingsRefusal(grant, request);
    if (!reason) return { grant };
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return {
    refusal: `You may start ${who}, but ${reasons.join("; or ")}.`,
  };
}

/**
 * Why the target's harness refuses the settings, from its own catalog: a
 * model it does not offer, or an effort its model does not take. Null when
 * it takes them, or when the catalog is unknown.
 */
export function catalogRefusal(input: {
  catalog: readonly AgentModelChoice[];
  /** The requested model. */
  model?: string;
  /** The model the child will run: requested, inherited or its default. */
  runningModel?: string;
  effort?: AgentEffort;
}): string | null {
  if (input.catalog.length === 0) return null;
  const find = (id: string) =>
    input.catalog.find(
      (choice) => choice.id === id || choice.resolvedId === id,
    );
  if (input.model !== undefined && !find(input.model)) {
    const ids = input.catalog.map((choice) => choice.id);
    return `${input.model} is not a model its harness offers. It offers: ${ids.slice(0, 30).join(", ")}${ids.length > 30 ? ", …" : ""}`;
  }
  if (input.effort !== undefined && input.runningModel !== undefined) {
    const choice = find(input.runningModel);
    if (choice?.supportsEffort === false)
      return `${choice.id} takes no effort setting`;
    const levels = choice?.supportedEffortLevels;
    if (levels?.length && !levels.includes(input.effort))
      return `${choice?.id ?? input.runningModel} takes effort ${levels.join(", ")}`;
  }
  return null;
}

function modelText(grant: AgentDelegationGrant): string {
  if (grant.model === "any") return "any model its harness offers";
  if (grant.model === "fixed") return "its own model";
  return `model ${grant.model.join(" or ")}`;
}

function effortText(grant: AgentDelegationGrant): string {
  if (grant.effort === "any") return `any effort (${EFFORTS.join(", ")})`;
  if (grant.effort === "fixed") return "its own effort";
  if (grant.effort === "at-most-parent")
    return "effort no higher than this chat's";
  return `effort ${grant.effort.join(" or ")}`;
}

interface MenuInput {
  policy: AgentDelegationPolicy;
  projectId: string;
  /** Agents a wildcard grant admits, with their names. */
  wildcardAgents: readonly { id: string; name?: string }[];
  /** An agent's display name, when the host knows it. */
  nameOf(agentId: string): string | undefined;
}

function grantWho(grant: AgentDelegationGrant, input: MenuInput): string {
  if (grant.agent === "self") return "A copy of yourself (leave agent out)";
  if (grant.agent === "*")
    return `Any of: ${
      input.wildcardAgents.length > 0
        ? input.wildcardAgents
            .map((agent) =>
              agent.name ? `${agent.id} (${agent.name})` : agent.id,
            )
            .join(", ")
        : "no agents right now"
    }`;
  const id = grantAgentId(grant, input.projectId);
  const name = input.nameOf(id);
  return `Agent ${id}${name ? ` (${name})` : ""}`;
}

/**
 * The agent's menu: whom it may start and what it may set, one line per
 * grant. It names no id to copy for a copy of yourself: leaving `agent` out
 * is the way.
 */
export function delegationMenu(input: MenuInput): string[] {
  return input.policy.agents.map(
    (grant) =>
      `- ${grantWho(grant, input)}: ${modelText(grant)}, ${effortText(grant)}${grant.delegate ? "" : ", and it cannot start subsessions"}${grant.description ? `. ${grant.description}` : ""}`,
  );
}
