import {
  hasProjectPermission,
  type Identity,
  type Membership,
  type ProjectRoleEntry,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";

export type AdmissionMode =
  | "invitation_only"
  | "approved_domain"
  | "request"
  | "open";

export interface AdmissionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

interface AdmissionServices {
  db: Kysely<DB>;
  membershipWriterIdentity: Identity;
  roles: {
    list(identity: Identity, projectId: string): Promise<ProjectRoleEntry[]>;
  };
  memberships: {
    list(input: {
      identity: Identity;
      projectId: string;
    }): Promise<Membership[]>;
    get(input: {
      identity: Identity;
      projectId: string;
      externalUserId: string;
    }): Promise<Membership | null>;
    grant(input: {
      identity: Identity;
      projectId: string;
      externalUserId: string;
      roles: readonly string[];
      grants?: Readonly<Record<string, readonly string[]>>;
    }): Promise<Membership>;
  };
}

export class StockAdmissionService {
  constructor(private readonly services: AdmissionServices) {}

  async listJoinableProjects(
    user: AdmissionUser,
  ): Promise<Array<{ id: string; name: string }>> {
    const policies = await this.services.db
      .selectFrom("stock_project_admission_policies as policy")
      .innerJoin("projects as project", "project.id", "policy.project_id")
      .where(
        "project.tenant_id",
        "=",
        this.services.membershipWriterIdentity.tenantId,
      )
      .where("policy.mode", "in", ["open", "approved_domain"])
      .select([
        "project.id as id",
        "project.name as name",
        "policy.mode as mode",
        "policy.approved_domains as approvedDomains",
      ])
      .orderBy("project.name", "asc")
      .execute();
    const domain = verifiedDomain(user);
    return policies.flatMap((policy) => {
      if (
        policy.mode === "approved_domain" &&
        (!domain || !stringArray(policy.approvedDomains).includes(domain))
      ) {
        return [];
      }
      return [{ id: policy.id, name: policy.name }];
    });
  }

  async listMembers(input: {
    identity: Identity;
    projectId: string;
  }): Promise<Membership[]> {
    assertPermission(input.identity, input.projectId, "memberships:manage");
    return this.services.memberships.list(input);
  }

  async setPolicy(input: {
    identity: Identity;
    projectId: string;
    mode: AdmissionMode;
    defaultRole: string;
    approvedDomains: readonly string[];
  }): Promise<void> {
    assertPermission(input.identity, input.projectId, "memberships:manage");
    await this.validateRoles({
      identity: input.identity,
      projectId: input.projectId,
      roles: [input.defaultRole],
    });
    const domains = normalizeDomains(input.approvedDomains);
    await this.services.db
      .insertInto("stock_project_admission_policies")
      .values({
        project_id: input.projectId,
        mode: input.mode,
        default_role: input.defaultRole,
        approved_domains: JSON.stringify(domains),
        updated_by_external_user_id: input.identity.externalUserId,
      })
      .onConflict((conflict) =>
        conflict.column("project_id").doUpdateSet({
          mode: input.mode,
          default_role: input.defaultRole,
          approved_domains: JSON.stringify(domains),
          updated_by_external_user_id: input.identity.externalUserId,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  async createInvitation(input: {
    identity: Identity;
    projectId: string;
    email?: string;
    roles?: readonly string[];
    grants?: Readonly<Record<string, readonly string[]>>;
    expiresAt?: Date;
  }): Promise<{ id: string; projectId: string; expiresAt: string }> {
    assertPermission(input.identity, input.projectId, "memberships:manage");
    const policy = await this.requirePolicy(input.projectId);
    const roles = [...new Set(input.roles ?? [policy.default_role])];
    await this.validateRoles({
      identity: input.identity,
      projectId: input.projectId,
      roles,
    });
    const row = await this.services.db
      .insertInto("stock_project_invitations")
      .values({
        project_id: input.projectId,
        invited_email: input.email ? normalizeEmail(input.email) : null,
        roles: JSON.stringify(roles),
        grants: JSON.stringify(normalizeGrants(input.grants)),
        created_by_external_user_id: input.identity.externalUserId,
        expires_at:
          input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60_000),
      })
      .returning(["id", "project_id", "expires_at"])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      projectId: row.project_id,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async redeemInvitation(input: {
    projectId: string;
    invitationId: string;
    user: AdmissionUser;
  }): Promise<Membership> {
    const existing = await this.existingMembership({
      projectId: input.projectId,
      userId: input.user.id,
    });
    if (existing) return existing;
    const invitation = await this.services.db
      .selectFrom("stock_project_invitations")
      .where("id", "=", input.invitationId)
      .where("project_id", "=", input.projectId)
      .selectAll()
      .executeTakeFirst();
    if (!invitation) {
      throw new Error("This invitation is no longer available");
    }
    const recoveringClaim =
      invitation.redeemed_at !== null &&
      invitation.redeemed_by_external_user_id === input.user.id;
    if (invitation.redeemed_at && !recoveringClaim) {
      throw new Error("This invitation is no longer available");
    }
    if (!recoveringClaim && invitation.expires_at.getTime() <= Date.now()) {
      throw new Error("This invitation has expired");
    }
    if (
      invitation.invited_email &&
      (!input.user.emailVerified ||
        normalizeEmail(input.user.email) !== invitation.invited_email)
    ) {
      throw new Error("The signed-in email does not match this invitation");
    }
    const roles = stringArray(invitation.roles);
    await this.validateRoles({
      identity: this.services.membershipWriterIdentity,
      projectId: input.projectId,
      roles,
    });
    const claimedAt = recoveringClaim ? invitation.redeemed_at : new Date();
    if (!recoveringClaim) {
      const claimed = await this.services.db
        .updateTable("stock_project_invitations")
        .set({
          redeemed_by_external_user_id: input.user.id,
          redeemed_at: claimedAt,
        })
        .where("id", "=", input.invitationId)
        .where("redeemed_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!claimed) throw new Error("This invitation is no longer available");
    }
    try {
      return await this.grant({
        projectId: input.projectId,
        userId: input.user.id,
        roles,
        grants: grantsObject(invitation.grants),
      });
    } catch (error) {
      if (!recoveringClaim) {
        await this.services.db
          .updateTable("stock_project_invitations")
          .set({
            redeemed_by_external_user_id: null,
            redeemed_at: null,
          })
          .where("id", "=", input.invitationId)
          .where("redeemed_by_external_user_id", "=", input.user.id)
          .where("redeemed_at", "=", claimedAt)
          .execute();
      }
      throw error;
    }
  }

  async join(input: {
    projectId: string;
    user: AdmissionUser;
  }): Promise<Membership> {
    const existing = await this.existingMembership({
      projectId: input.projectId,
      userId: input.user.id,
    });
    if (existing) return existing;
    const policy = await this.requirePolicy(input.projectId);
    if (policy.mode === "invitation_only") {
      throw new Error("This project requires an invitation");
    }
    if (policy.mode === "request") {
      throw new Error("Request access to this project before joining");
    }
    if (policy.mode === "approved_domain") {
      const domain = verifiedDomain(input.user);
      if (!domain) throw new Error("A verified email is required to join");
      if (!stringArray(policy.approved_domains).includes(domain)) {
        throw new Error("Your verified email domain is not approved");
      }
    }
    await this.validateRoles({
      identity: this.services.membershipWriterIdentity,
      projectId: input.projectId,
      roles: [policy.default_role],
    });
    return this.grant({
      projectId: input.projectId,
      userId: input.user.id,
      roles: [policy.default_role],
      grants: {},
    });
  }

  async requestAccess(input: {
    projectId: string;
    user: AdmissionUser;
  }): Promise<{ id: string; status: string }> {
    const policy = await this.requirePolicy(input.projectId);
    if (policy.mode !== "request") {
      throw new Error("This project is not accepting access requests");
    }
    const existing = await this.services.db
      .selectFrom("stock_project_access_requests")
      .where("project_id", "=", input.projectId)
      .where("external_user_id", "=", input.user.id)
      .where("status", "=", "pending")
      .select(["id", "status"])
      .executeTakeFirst();
    if (existing) return existing;
    return this.services.db
      .insertInto("stock_project_access_requests")
      .values({
        project_id: input.projectId,
        external_user_id: input.user.id,
        email: normalizeEmail(input.user.email),
        email_verified: input.user.emailVerified,
      })
      .returning(["id", "status"])
      .executeTakeFirstOrThrow();
  }

  async listAccessRequests(input: {
    identity: Identity;
    projectId: string;
  }): Promise<
    Array<{
      id: string;
      externalUserId: string;
      email: string;
      emailVerified: boolean;
      status: string;
      requestedAt: string;
    }>
  > {
    assertPermission(input.identity, input.projectId, "memberships:manage");
    const rows = await this.services.db
      .selectFrom("stock_project_access_requests")
      .where("project_id", "=", input.projectId)
      .where("status", "=", "pending")
      .select([
        "id",
        "external_user_id",
        "email",
        "email_verified",
        "status",
        "requested_at",
      ])
      .orderBy("requested_at", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      externalUserId: row.external_user_id,
      email: row.email,
      emailVerified: row.email_verified,
      status: row.status,
      requestedAt: row.requested_at.toISOString(),
    }));
  }

  async decideRequest(input: {
    identity: Identity;
    requestId: string;
    decision: "approved" | "denied";
  }): Promise<{ id: string; status: string }> {
    const request = await this.services.db
      .selectFrom("stock_project_access_requests")
      .where("id", "=", input.requestId)
      .selectAll()
      .executeTakeFirst();
    if (!request) throw new Error("This access request does not exist");
    assertPermission(input.identity, request.project_id, "memberships:manage");
    if (request.status === "approved" && input.decision === "approved") {
      return { id: request.id, status: request.status };
    }
    if (request.status !== "pending") {
      throw new Error("This access request is no longer pending");
    }
    const policy = await this.requirePolicy(request.project_id);
    if (input.decision === "approved") {
      await this.validateRoles({
        identity: input.identity,
        projectId: request.project_id,
        roles: [policy.default_role],
      });
    }
    return this.services.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .updateTable("stock_project_access_requests")
        .set({
          status: input.decision,
          decided_by_external_user_id: input.identity.externalUserId,
          decided_at: new Date(),
        })
        .where("id", "=", input.requestId)
        .where("status", "=", "pending")
        .returning(["id", "status"])
        .executeTakeFirst();
      if (!row) throw new Error("This access request is no longer pending");
      if (input.decision === "approved") {
        await transaction
          .insertInto("memberships")
          .values({
            project_id: request.project_id,
            external_user_id: request.external_user_id,
            roles: JSON.stringify([policy.default_role]),
            grants: JSON.stringify({}),
          })
          .onConflict((conflict) =>
            conflict.columns(["project_id", "external_user_id"]).doNothing(),
          )
          .execute();
      }
      return row;
    });
  }

  private async requirePolicy(projectId: string) {
    const policy = await this.services.db
      .selectFrom("stock_project_admission_policies")
      .where("project_id", "=", projectId)
      .selectAll()
      .executeTakeFirst();
    if (!policy) throw new Error("Project admission is not configured");
    return policy;
  }

  private async validateRoles(input: {
    identity: Identity;
    projectId: string;
    roles: readonly string[];
  }): Promise<void> {
    const entries = await this.services.roles.list(
      this.services.membershipWriterIdentity,
      input.projectId,
    );
    for (const role of input.roles) {
      const entry = entries.find((candidate) => candidate.slug === role);
      if (!entry?.definition) {
        throw new Error(
          `Project ${input.projectId} has no valid committed role "${role}"`,
        );
      }
      if ((entry.definition.permissions?.length ?? 0) > 0) {
        assertPermission(input.identity, input.projectId, "roles:manage");
      }
    }
  }

  private grant(input: {
    projectId: string;
    userId: string;
    roles: readonly string[];
    grants: Readonly<Record<string, readonly string[]>>;
  }): Promise<Membership> {
    return this.services.memberships.grant({
      identity: this.services.membershipWriterIdentity,
      projectId: input.projectId,
      externalUserId: input.userId,
      roles: input.roles,
      grants: input.grants,
    });
  }

  private existingMembership(input: {
    projectId: string;
    userId: string;
  }): Promise<Membership | null> {
    return this.services.memberships.get({
      identity: this.services.membershipWriterIdentity,
      projectId: input.projectId,
      externalUserId: input.userId,
    });
  }
}

function assertPermission(
  identity: Identity,
  projectId: string,
  permission: "memberships:manage" | "roles:manage",
): void {
  if (!hasProjectPermission(identity, projectId, permission)) {
    throw new Error("You do not have permission to manage project access");
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function verifiedDomain(user: AdmissionUser): string | null {
  if (!user.emailVerified) return null;
  const separator = normalizeEmail(user.email).lastIndexOf("@");
  return separator > 0 ? normalizeEmail(user.email).slice(separator + 1) : null;
}

function normalizeDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
}

function normalizeGrants(
  grants: Readonly<Record<string, readonly string[]>> | undefined,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(grants ?? {}).map(([key, values]) => [
      key,
      [...new Set(values.filter(Boolean))],
    ]),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function grantsObject(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, values]) =>
      Array.isArray(values) ? [[key, stringArray(values)]] : [],
    ),
  );
}
