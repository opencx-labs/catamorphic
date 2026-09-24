import type { Identity } from "../identity.js";
import {
  type AgentRef,
  EVERY_ARTIFACT,
  hasProjectPermission,
  isProjectPrincipal,
  scopeCovers,
  scopeCoversSessions,
} from "../identity.js";
import { parseProjectAgentId } from "./agent-definitions-service.js";
import { AccessDeniedError } from "./artifact-scope.js";

/**
 * The session boundary shared by chat and durable runtime surfaces. Scoped
 * callers use their own sessions on a project agent their scope covers.
 * Everyone's sessions take a permission (ADR 0158): `sessions:read` to read
 * them, `sessions:write` to change them. Root holds both.
 *
 * `intent` says what the caller is about to do. A sessions ref (an app
 * version that declared `access.sessions: "read"`, ADR 0148) reads the
 * viewer's sessions on every agent of the project, and only reads: changing
 * a session (delivering, interrupting, archiving, forking) takes the agent
 * ref its chat runs on, which no app-widened identity carries.
 *
 * A project chat (owned by the project principal, ADR 0156) is shared: anyone
 * whose role reaches its agent reads it and works in it.
 */
export function assertAgentSessionAccess(args: {
  identity: Identity;
  projectId: string;
  externalUserId: string;
  agentId: string | null;
  intent: "read" | "change";
}): void {
  if (
    hasProjectPermission(
      args.identity,
      args.projectId,
      args.intent === "read" ? "sessions:read" : "sessions:write",
    )
  )
    return;
  if (isProjectPrincipal(args.externalUserId)) {
    if (coveringProjectAgentRef(args)) return;
    throw new AccessDeniedError();
  }
  if (args.externalUserId !== args.identity.externalUserId)
    throw new AccessDeniedError();
  if (
    args.intent === "read" &&
    scopeCoversSessions(args.identity, args.projectId)
  )
    return;
  if (
    !coveringProjectAgentRef({
      identity: args.identity,
      projectId: args.projectId,
      agentId: args.agentId,
    })
  ) {
    throw new AccessDeniedError();
  }
}

function coveringProjectAgentRef(args: {
  identity: Identity;
  projectId: string;
  agentId: string | null;
}): AgentRef | undefined {
  if (!args.identity.scope) return undefined;
  // `agents: ["*"]` reaches every agent the project offers, the host's own
  // (and a session with no agent) included.
  const every: AgentRef = {
    kind: "agent",
    projectId: args.projectId,
    name: EVERY_ARTIFACT,
  };
  if (
    args.identity.scope.some(
      (entry) =>
        entry.kind === "agent" &&
        entry.projectId === args.projectId &&
        entry.name === EVERY_ARTIFACT,
    )
  )
    return every;
  if (!args.agentId) return undefined;
  const parsed = parseProjectAgentId(args.agentId);
  if (!parsed || parsed.projectId !== args.projectId) return undefined;
  const ref: AgentRef = {
    kind: "agent",
    projectId: args.projectId,
    name: parsed.slug,
  };
  return scopeCovers(args.identity.scope, ref) ? ref : undefined;
}
