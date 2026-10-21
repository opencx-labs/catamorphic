import { AGENT_EFFORT_LEVELS, type AgentEffort } from "@catamorphic/sandbox";
import {
  type AgentDelegationGrant,
  type AgentDelegationPolicy,
  formatProjectAgentId,
} from "./agent-definitions-service.js";
import type { AgentModelChoice } from "./coding-agent-registry.js";

/**
 * Who an agent may start as a subsession, and what it may choose for them
 * (ADR 0271). Grants are matched here, apart from sessions, so the rules
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

/** A stored effort as one, or undefined for anything else. */
export function effortOf(
  value: string | null | undefined,
): AgentEffort | undefined {
  return AGENT_EFFORT_LEVELS.find((effort) => effort === value);
}

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
  /**
   * A wildcard grant admits the target: the host lists it, and its
   * sandboxing is no wider.
   */
  wildcardAdmits: boolean;
  /** The names a model goes by: its catalog id and the one it resolves to. */
  modelNames?(model: string): readonly string[];
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

/** A grant that names the target: itself (`self`), or its id. */
function names(grant: AgentDelegationGrant, request: DelegationRequest) {
  if (grant.agent === "self")
    return request.targetAgentId === request.sourceAgentId;
  if (grant.agent === "*") return false;
  return grantAgentId(grant, request.projectId) === request.targetAgentId;
}

function listed(
  list: readonly string[],
  model: string,
  modelNames: DelegationRequest["modelNames"],
): boolean {
  const known = (modelNames?.(model) ?? [model]).map((name) =>
    name.toLowerCase(),
  );
  return list.some((entry) => known.includes(entry.toLowerCase()));
}

/** Why `grant` refuses the requested settings, or null when it takes them. */
function settingsRefusal(
  grant: AgentDelegationGrant,
  request: DelegationRequest,
): string | null {
  if (request.model !== undefined) {
    if (grant.model === "fixed") return "its model is fixed";
    if (
      Array.isArray(grant.model) &&
      !listed(grant.model, request.model, request.modelNames)
    )
      return `its model is one of ${grant.model.join(", ")}`;
  }
  if (request.effort !== undefined) {
    if (grant.effort === "fixed") return "its effort is fixed";
    if (grant.effort === "at-most-parent") {
      // A chat on its harness's default effort runs at least `low`.
      const ceiling = request.parentEffort ?? "low";
      if (
        AGENT_EFFORT_LEVELS.indexOf(request.effort) >
        AGENT_EFFORT_LEVELS.indexOf(ceiling)
      )
        return request.parentEffort
          ? `its effort is at most this chat's, ${request.parentEffort}`
          : "this chat runs on its harness's default effort, so ask for low or leave effort out";
    }
    if (Array.isArray(grant.effort) && !grant.effort.includes(request.effort))
      return `its effort is one of ${grant.effort.join(", ")}`;
  }
  return null;
}

/**
 * The grant that admits the target and takes the requested settings, or
 * why none does. Grants that name the target decide before a wildcard,
 * so `*` never lifts the limits set for one agent; among them the first
 * that takes the settings applies. A refusal says what is allowed instead.
 */
export function chooseGrant(
  policy: AgentDelegationPolicy,
  request: DelegationRequest,
): { grant: AgentDelegationGrant } | { refusal: string } {
  const named = policy.agents.filter((grant) => names(grant, request));
  const candidates =
    named.length > 0
      ? named
      : request.wildcardAdmits
        ? policy.agents.filter((grant) => grant.agent === "*")
        : [];
  const who =
    request.targetAgentId === request.sourceAgentId
      ? "a copy of yourself"
      : `agent ${request.targetAgentId}`;
  if (candidates.length === 0) return { refusal: `You may not start ${who}.` };
  const reasons: string[] = [];
  for (const grant of candidates) {
    const reason = settingsRefusal(grant, request);
    if (!reason) return { grant };
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return {
    refusal: `You may start ${who}, but ${reasons.join("; or ")}.`,
  };
}

/**
 * The model and effort a child runs on. A copy keeps the parent chat's
 * model and effort as a pair: a new model drops the parent's effort,
 * which was chosen for the old one. Another agent starts on its own. A
 * grant's list holds what the child runs on, not only what is asked: an
 * unlisted inherited or default setting gives way to the first listed.
 * `at-most-parent` holds what it runs on to the parent's effort too, when
 * the parent's is known.
 */
export function childSettings(input: {
  grant: AgentDelegationGrant;
  copy: boolean;
  requested: { model?: string; effort?: AgentEffort };
  parent: { model?: string; effort?: AgentEffort };
  /** The parent chat's effort now: its own, or its agent's default. */
  parentEffort?: AgentEffort;
  /** The target agent's own defaults, what runs when nothing is set. */
  own: { model?: string; effort?: AgentEffort };
  modelNames?: DelegationRequest["modelNames"];
}): { model?: string; effort?: AgentEffort } {
  const { grant, copy, requested, parent, own } = input;
  let model = requested.model ?? (copy ? parent.model : undefined);
  const runningModel = model ?? own.model;
  if (
    Array.isArray(grant.model) &&
    requested.model === undefined &&
    !(
      runningModel !== undefined &&
      listed(grant.model, runningModel, input.modelNames)
    )
  )
    model = grant.model[0];
  let effort =
    requested.effort ??
    (copy && requested.model === undefined ? parent.effort : undefined);
  const runningEffort = effort ?? own.effort;
  if (
    Array.isArray(grant.effort) &&
    requested.effort === undefined &&
    !(runningEffort !== undefined && grant.effort.includes(runningEffort))
  )
    effort = grant.effort[0];
  if (
    grant.effort === "at-most-parent" &&
    input.parentEffort &&
    runningEffort &&
    AGENT_EFFORT_LEVELS.indexOf(runningEffort) >
      AGENT_EFFORT_LEVELS.indexOf(input.parentEffort)
  )
    effort = input.parentEffort;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** A model's catalog entry, by its id or the id it resolves to, any case. */
export function catalogEntry(
  catalog: readonly AgentModelChoice[],
  model: string,
): AgentModelChoice | undefined {
  const wanted = model.toLowerCase();
  return catalog.find(
    (choice) =>
      choice.id.toLowerCase() === wanted ||
      choice.resolvedId?.toLowerCase() === wanted,
  );
}

/** Whether `model` takes `effort`, as far as the catalog says. */
export function effortFits(input: {
  catalog: readonly AgentModelChoice[];
  model: string | undefined;
  effort: AgentEffort;
}): boolean {
  const choice = input.model
    ? catalogEntry(input.catalog, input.model)
    : undefined;
  if (!choice) return true;
  if (choice.supportsEffort === false) return false;
  return (
    !choice.supportedEffortLevels?.length ||
    choice.supportedEffortLevels.includes(input.effort)
  );
}

/**
 * Why the target's harness refuses the requested settings, from its own
 * catalog: a model it does not offer, or an effort its model does not
 * take. Null when it takes them, or when the catalog is empty.
 */
export function catalogRefusal(input: {
  catalog: readonly AgentModelChoice[];
  /** Whose harness: "your harness", or another agent's. */
  harness: string;
  /** The requested model. */
  model?: string;
  /** The model the child will run: requested, inherited or its default. */
  runningModel?: string;
  effort?: AgentEffort;
}): string | null {
  if (input.catalog.length === 0) return null;
  if (input.model !== undefined && !catalogEntry(input.catalog, input.model)) {
    const ids = input.catalog.map((choice) => choice.id);
    return `${input.model} is not a model ${input.harness} offers. It offers: ${ids.slice(0, 30).join(", ")}${ids.length > 30 ? ", …" : ""}`;
  }
  if (
    input.effort !== undefined &&
    !effortFits({
      catalog: input.catalog,
      model: input.runningModel,
      effort: input.effort,
    })
  ) {
    const choice = input.runningModel
      ? catalogEntry(input.catalog, input.runningModel)
      : undefined;
    return choice?.supportsEffort === false
      ? `${choice.id} takes no effort setting`
      : `${choice?.id ?? input.runningModel} takes effort ${choice?.supportedEffortLevels?.join(", ")}`;
  }
  return null;
}

function modelText(grant: AgentDelegationGrant): string {
  if (grant.model === "any") return "any model its harness offers";
  if (grant.model === "fixed")
    return grant.agent === "self" ? "this chat's model" : "its own model";
  return `model ${grant.model.join(" or ")}`;
}

function effortText(grant: AgentDelegationGrant): string {
  if (grant.effort === "any")
    return `any effort (${AGENT_EFFORT_LEVELS.join(", ")})`;
  if (grant.effort === "fixed")
    return grant.agent === "self" ? "this chat's effort" : "its own effort";
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
 * grant. It names no id for a copy of yourself: leaving `agent` out is
 * the way.
 */
export function delegationMenu(input: MenuInput): string[] {
  return input.policy.agents.map(
    (grant) =>
      `- ${grantWho(grant, input)}: ${modelText(grant)}, ${effortText(grant)}${grant.delegate ? "" : ", and it cannot start subsessions"}${grant.description ? `. ${grant.description}` : ""}`,
  );
}
