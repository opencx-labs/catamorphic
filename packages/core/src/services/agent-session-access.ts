import type { Identity } from "../identity.js";
import { type AgentRef, isBuilder, scopeCovers } from "../identity.js";
import { parseProjectAgentId } from "./agent-definitions-service.js";
import { AccessDeniedError } from "./artifact-scope.js";

/**
 * The session boundary shared by chat and durable runtime surfaces. Scoped
 * callers can use only their own sessions on the exact project agent covered
 * by their scope. Builders and root identities retain project-wide access.
 */
export function assertAgentSessionAccess(args: {
  identity: Identity;
  projectId: string;
  externalUserId: string;
  agentId: string | null;
}): void {
  if (isBuilder(args.identity, args.projectId)) return;
  if (
    args.externalUserId !== args.identity.externalUserId ||
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
