import type { Identity } from "../identity.js";
import {
  type AgentRef,
  isBuilder,
  isTeamPrincipal,
  scopeCovers,
  scopeCoversSessions,
} from "../identity.js";
import { parseProjectAgentId } from "./agent-definitions-service.js";
import { AccessDeniedError } from "./artifact-scope.js";

/**
 * The session boundary shared by chat and durable runtime surfaces. Scoped
 * callers can use only their own sessions on the exact project agent covered
 * by their scope. Builders and root identities retain project-wide access.
 *
 * `intent` says what the caller is about to do. A sessions ref (an app
 * version that declared `access.sessions: "read"`, ADR 0148) reads the
 * viewer's sessions on every agent of the project, and only reads: changing
 * a session (delivering, interrupting, archiving, forking) takes the agent
 * ref its chat runs on, which no app-widened identity carries.
 *
 * A team chat (owned by the team principal, ADR 0156) is shared: anyone
 * whose role reaches its agent reads it and works in it.
 */
export function assertAgentSessionAccess(args: {
  identity: Identity;
  projectId: string;
  externalUserId: string;
  agentId: string | null;
  intent: "read" | "change";
}): void {
  if (isBuilder(args.identity, args.projectId)) return;
  if (isTeamPrincipal(args.externalUserId)) {
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
  if (!args.agentId || !args.identity.scope) return undefined;
  const parsed = parseProjectAgentId(args.agentId);
  if (!parsed || parsed.projectId !== args.projectId) return undefined;
  const ref: AgentRef = {
    kind: "agent",
    projectId: args.projectId,
    name: parsed.slug,
  };
  return scopeCovers(args.identity.scope, ref) ? ref : undefined;
}
