import {
  type Identity,
  isBuilder,
  isTeamPrincipal,
  teamIdentity,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";

/**
 * Whose chat a workflow wakes (ADR 0156). A member's automation wakes its
 * member's chat. A team automation wakes the team's chat, or a named
 * member's. A run started by hand acts for its caller, and only a builder
 * may wake the team from one.
 */
export async function wakeAudience(input: {
  /** The run's caller: the enablement's owner, or whoever started it. */
  caller: Identity;
  projectId: string;
  audience: "team" | { member: string } | undefined;
  enablement:
    | { owner_kind: string; owner_external_user_id: string | null }
    | undefined;
  environment: string | undefined;
  resolveMember(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }): Promise<Identity | null>;
}): Promise<Identity> {
  const { caller, audience, enablement } = input;
  const team = () => {
    // A team automation's run already acts as the team, with its consented
    // connections; a builder's hand-started run gets a bare team identity.
    if (isTeamPrincipal(caller.externalUserId)) return caller;
    if (!input.environment)
      throw new Error("A team chat needs an Environment to run in");
    return teamIdentity({
      tenantId: caller.tenantId,
      projectId: input.projectId,
      environment: input.environment,
    });
  };
  if (enablement?.owner_kind === "member") {
    if (
      audience === "team" ||
      (audience && audience.member !== enablement.owner_external_user_id)
    )
      throw new Error(
        "A member's automation wakes only that member's chat; enable it for the team to reach others",
      );
    return caller;
  }
  if (enablement?.owner_kind === "team") {
    if (!audience || audience === "team") return team();
    const member = await input.resolveMember({
      tenantId: caller.tenantId,
      projectId: input.projectId,
      externalUserId: audience.member,
    });
    if (!member)
      throw new Error(`${audience.member} is not a member of this project`);
    return member;
  }
  if (audience === "team") {
    if (!isBuilder(caller, input.projectId)) throw new AccessDeniedError();
    return team();
  }
  if (audience && audience.member !== caller.externalUserId)
    throw new Error("A run started by hand wakes only its caller's chat");
  return caller;
}
