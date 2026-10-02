import type { RuntimeRequest } from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { isProjectPrincipal } from "../../identity.js";

type Executor = Kysely<DB> | Transaction<DB>;

/** How long a person's own chat waits for them to approve. */
export const ATTENDED_APPROVAL_MS = 5 * 60_000;
/** How long an unattended chat waits for its approvers by default. */
export const UNATTENDED_APPROVAL_MS = 30 * 60_000;

const approversSchema = z.object({
  members: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
});
const allocationApprovalsSchema = z.object({
  approvals: z.object({ waitMinutes: z.number() }).optional(),
});

/** Who answers a chat's approvals, and for how long it waits (ADR 0176). */
export interface ApprovalPolicy {
  tenantId: string;
  projectId: string;
  title: string | null;
  /** No person is in the chat: a project chat, or one with named approvers. */
  unattended: boolean;
  /** The people who answer an unattended chat's approvals. */
  approvers: string[];
  waitMs: number;
}

/**
 * A chat someone is in answers its own approvals, promptly or not at all.
 * An unattended chat routes each one to its approvers (named members,
 * holders of named roles, and its own person) and waits as long as its
 * Environment says.
 */
export async function approvalPolicy(
  db: Executor,
  sessionId: string,
): Promise<ApprovalPolicy> {
  const session = await db
    .selectFrom("agent_sessions")
    .innerJoin("projects", "projects.id", "agent_sessions.project_id")
    .leftJoin(
      "execution_allocations",
      "execution_allocations.id",
      "agent_sessions.allocation_id",
    )
    .select([
      "projects.tenant_id",
      "agent_sessions.external_user_id",
      "agent_sessions.project_id",
      "agent_sessions.title",
      "agent_sessions.approvers",
      "execution_allocations.policy_snapshot",
    ])
    .where("agent_sessions.id", "=", sessionId)
    .executeTakeFirstOrThrow();
  const named = approversSchema.safeParse(session.approvers);
  const declared =
    session.approvers !== null && named.success ? named.data : undefined;
  const allocation = allocationApprovalsSchema.safeParse(
    session.policy_snapshot,
  );
  const waitMinutes = allocation.success
    ? allocation.data.approvals?.waitMinutes
    : undefined;
  const owner = session.external_user_id;
  const unattended = isProjectPrincipal(owner) || declared !== undefined;
  const roles = new Set(declared?.roles ?? []);
  const holders =
    roles.size === 0
      ? []
      : (
          await db
            .selectFrom("memberships")
            .select(["external_user_id", "roles"])
            .where("project_id", "=", session.project_id)
            .execute()
        )
          .filter(
            (row) =>
              Array.isArray(row.roles) &&
              row.roles.some(
                (role) => typeof role === "string" && roles.has(role),
              ),
          )
          .map((row) => row.external_user_id);
  const approvers = unattended
    ? [
        ...new Set([
          ...(isProjectPrincipal(owner) ? [] : [owner]),
          ...(declared?.members ?? []),
          ...holders,
        ]),
      ].sort()
    : [];
  return {
    tenantId: session.tenant_id,
    projectId: session.project_id,
    title: session.title,
    unattended,
    approvers,
    waitMs: !unattended
      ? ATTENDED_APPROVAL_MS
      : waitMinutes
        ? waitMinutes * 60_000
        : UNATTENDED_APPROVAL_MS,
  };
}

/**
 * An approval as it opens under its chat's policy: who answers it and when
 * it expires, or why it is refused at once because no one can.
 */
export function governApproval(input: {
  request: RuntimeRequest;
  policy: ApprovalPolicy;
  now: number;
}): { request: RuntimeRequest; refusal?: string } {
  const { request, policy } = input;
  const action = request.approval?.tool
    ? `"${request.approval.tool.name}" on ${request.approval.tool.server ?? "this agent"}`
    : (request.approval?.action ?? request.title);
  if (policy.unattended && policy.approvers.length === 0) {
    const refusal = `${action} needs a person's approval, and no one watches this chat. The automation that delivers into it can name approvers (members or project roles).`;
    return {
      refusal,
      request: {
        ...request,
        status: "cancelled",
        answerable: false,
        reason: refusal,
        resolvedAt: new Date(input.now).toISOString(),
      },
    };
  }
  return {
    request: {
      ...request,
      approvers: policy.approvers,
      expiresAt: new Date(input.now + policy.waitMs).toISOString(),
    },
  };
}

/** What the agent is told when nobody answered an approval in time. */
export function expiredApprovalReason(request: RuntimeRequest): string {
  const created = Date.parse(request.createdAt);
  const expires = request.expiresAt ? Date.parse(request.expiresAt) : created;
  const minutes = Math.max(1, Math.round((expires - created) / 60_000));
  return `No one answered the approval for ${request.approval?.tool?.name ?? request.title} within ${minutes} minutes, so it was not run.`;
}
