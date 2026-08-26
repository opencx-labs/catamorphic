import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import {
  hasProjectPermission,
  type Identity,
  type ProjectPermissionRef,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import { requireTenantProject } from "./projects-service.js";
import type { RoleGrants, RolesService } from "./roles-service.js";

/**
 * Stock project memberships (ADR 0055): `user → roles + grants` per project.
 * The one piece every host would rebuild identically, so it ships — but as
 * a *source* for {@link RolesService.resolve}, not as policy: what a role
 * may do lives in the committed `roles/<slug>.json`, and a host with its own
 * entitlement tables never touches this table.
 *
 * Who the user *is* (signup, SSO, tokens, the invite email) stays the
 * host's. An invite is `grant(...)` plus whatever link the host sends.
 */
export interface Membership {
  projectId: string;
  externalUserId: string;
  roles: string[];
  grants: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

export interface GrantMembershipInput {
  /** A builder of the project (admins invite). */
  identity: Identity;
  projectId: string;
  externalUserId: string;
  roles: readonly string[];
  grants?: RoleGrants;
}

export class MembershipsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly roles: RolesService,
  ) {}

  /** Create or replace a member's roles and grants. */
  async grant(input: GrantMembershipInput): Promise<Membership> {
    assertProjectPermission(
      input.identity,
      input.projectId,
      "memberships:manage",
    );
    await this.requireProject(input.identity.tenantId, input.projectId);
    const roles = [...new Set(input.roles)];
    if (
      await this.roles.assignedRolesRequireManagement({
        tenantId: input.identity.tenantId,
        projectId: input.projectId,
        roles,
      })
    ) {
      assertProjectPermission(input.identity, input.projectId, "roles:manage");
    }
    const grants = normalizeGrants(input.grants);
    const row = await this.db
      .insertInto("memberships")
      .values({
        project_id: input.projectId,
        external_user_id: input.externalUserId,
        roles: JSON.stringify(roles),
        grants: JSON.stringify(grants),
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "external_user_id"]).doUpdateSet({
          roles: JSON.stringify(roles),
          grants: JSON.stringify(grants),
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapMembership(row);
  }

  /** Remove a member entirely. Returns whether a row existed. */
  async revoke(input: {
    identity: Identity;
    projectId: string;
    externalUserId: string;
  }): Promise<boolean> {
    assertProjectPermission(
      input.identity,
      input.projectId,
      "memberships:manage",
    );
    await this.requireProject(input.identity.tenantId, input.projectId);
    const result = await this.db
      .deleteFrom("memberships")
      .where("project_id", "=", input.projectId)
      .where("external_user_id", "=", input.externalUserId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async list(input: {
    identity: Identity;
    projectId: string;
  }): Promise<Membership[]> {
    assertProjectPermission(
      input.identity,
      input.projectId,
      "memberships:manage",
    );
    await this.requireProject(input.identity.tenantId, input.projectId);
    const rows = await this.db
      .selectFrom("memberships")
      .where("project_id", "=", input.projectId)
      .selectAll()
      .orderBy("external_user_id", "asc")
      .execute();
    return rows.map(mapMembership);
  }

  /** One member's row, for builders — or the member's own. */
  async get(input: {
    identity: Identity;
    projectId: string;
    externalUserId: string;
  }): Promise<Membership | null> {
    if (input.identity.externalUserId !== input.externalUserId) {
      assertProjectPermission(
        input.identity,
        input.projectId,
        "memberships:manage",
      );
    }
    await this.requireProject(input.identity.tenantId, input.projectId);
    const row = await this.db
      .selectFrom("memberships")
      .where("project_id", "=", input.projectId)
      .where("external_user_id", "=", input.externalUserId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapMembership(row) : null;
  }

  /**
   * The identity a member gets: their membership row expanded through the
   * project's committed roles. `null` when the user is not a member — the
   * host decides whether that is 401, 403 or a signup prompt. This is the
   * whole body of a host's identity resolver once its own auth has verified
   * who is calling.
   */
  async identityFor(input: {
    projectId: string;
    tenantId: string;
    externalUserId: string;
  }): Promise<Identity | null> {
    const row = await this.db
      .selectFrom("memberships")
      .innerJoin("projects", "projects.id", "memberships.project_id")
      .where("memberships.project_id", "=", input.projectId)
      .where("memberships.external_user_id", "=", input.externalUserId)
      .where("projects.tenant_id", "=", input.tenantId)
      .selectAll("memberships")
      .executeTakeFirst();
    if (!row) return null;
    const membership = mapMembership(row);
    return this.roles.resolve({
      tenantId: input.tenantId,
      projectId: input.projectId,
      externalUserId: input.externalUserId,
      roles: membership.roles,
      grants: membership.grants,
    });
  }

  /** Expand every current project membership for one verified host user. */
  async identityForUser(input: {
    tenantId: string;
    externalUserId: string;
  }): Promise<Identity> {
    const rows = await this.db
      .selectFrom("memberships")
      .innerJoin("projects", "projects.id", "memberships.project_id")
      .where("memberships.external_user_id", "=", input.externalUserId)
      .where("projects.tenant_id", "=", input.tenantId)
      .selectAll("memberships")
      .orderBy("memberships.project_id", "asc")
      .execute();
    const identities = await Promise.all(
      rows.map((row) => {
        const membership = mapMembership(row);
        return this.roles.resolve({
          tenantId: input.tenantId,
          projectId: membership.projectId,
          externalUserId: input.externalUserId,
          roles: membership.roles,
          grants: membership.grants,
        });
      }),
    );
    return {
      tenantId: input.tenantId,
      externalUserId: input.externalUserId,
      scope: dedupe(identities.flatMap((identity) => identity.scope ?? [])),
      executionScope: dedupe(
        identities.flatMap((identity) => identity.executionScope ?? []),
      ),
      connectionScope: dedupe(
        identities.flatMap((identity) => identity.connectionScope ?? []),
      ),
      projectPermissions: dedupeProjectPermissions(
        identities.flatMap((identity) => identity.projectPermissions ?? []),
      ),
    };
  }

  private requireProject(tenantId: string, projectId: string) {
    return requireTenantProject(this.db, tenantId, projectId);
  }
}

function assertProjectPermission(
  identity: Identity,
  projectId: string,
  permission: "memberships:manage" | "roles:manage",
): void {
  if (!hasProjectPermission(identity, projectId, permission)) {
    throw new AccessDeniedError();
  }
}

function dedupe<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeProjectPermissions(
  values: readonly ProjectPermissionRef[],
): ProjectPermissionRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.projectId}:${value.permission}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeGrants(
  grants: RoleGrants | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [param, values] of Object.entries(grants ?? {})) {
    const cleaned = [...new Set(values.filter((v) => v.length > 0))];
    if (cleaned.length > 0) out[param] = cleaned;
  }
  return out;
}

function mapMembership(row: {
  project_id: string;
  external_user_id: string;
  roles: unknown;
  grants: unknown;
  created_at: Date;
  updated_at: Date;
}): Membership {
  const roles = Array.isArray(row.roles)
    ? row.roles.filter((r): r is string => typeof r === "string")
    : [];
  const grants: Record<string, string[]> = {};
  if (
    row.grants &&
    typeof row.grants === "object" &&
    !Array.isArray(row.grants)
  ) {
    for (const [param, values] of Object.entries(
      row.grants as Record<string, unknown>,
    )) {
      if (Array.isArray(values)) {
        grants[param] = values.filter(
          (v): v is string => typeof v === "string",
        );
      }
    }
  }
  return {
    projectId: row.project_id,
    externalUserId: row.external_user_id,
    roles,
    grants,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
