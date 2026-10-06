import { createHash } from "node:crypto";
import type { ProjectEventsService } from "@catamorphic/core";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  DIRECTORY_EVENT_KINDS,
  DIRECTORY_EVENT_SOURCE,
  type DirectoryEventKind,
  type DirectoryMember,
  directoryProjectEvent,
} from "@catamorphic/server-sdk";
import { type Kysely, sql, type Transaction } from "kysely";
import type {
  WorkDirectoryPolicy,
  WorkSessionPolicy,
} from "../auth/auth-config.js";
import type { WorkAuth, WorkAuthUser } from "../auth/work-auth.js";
import {
  type DirectoryProvider,
  DirectoryUnavailableError,
  normalizeGroup,
} from "./directory.js";

const tracer = getTracer("@catamorphic/work-server");

export type AccountStanding =
  /** The directory confirmed the account, or it has no directory. */
  | "active"
  /** The directory is unreachable but a recent answer is within grace. */
  | "active_within_grace"
  /** Definitively inactive; the account is now disabled. */
  | "disabled"
  /** No recent answer and the directory is unreachable. */
  | "unknown";

export interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
}

export type GrantDecision =
  | { allow: true }
  | { allow: false; error: "invalid_grant"; description: string };

/**
 * Account lifecycle for company deployments (ADR 0161): upstream directory
 * checks, disabled accounts, and rotating refresh token families. Disabled
 * accounts keep their memberships and history; they cannot authenticate.
 *
 * Each transition (an account joins at its first sign-in or a sign-in that
 * re-enables it, leaves when disabled, or its groups change) is a durable
 * directory event (ADR 0210), recorded in the transaction that records the
 * transition, in every project that listens for it.
 */
export class AccountLifecycle {
  /** Replica memory (c): directory providers configured at boot. */
  private readonly directories: Map<string, DirectoryProvider>;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      auth: Pick<
        WorkAuth,
        | "accountsFor"
        | "deleteGrants"
        | "findUserById"
        | "grantByAccessToken"
        | "signOutEverywhere"
        | "usersSignedIn"
      >;
      directories: readonly DirectoryProvider[];
      sessions: WorkSessionPolicy;
      directory: WorkDirectoryPolicy;
      /** The tenant whose projects hear directory events. */
      tenantId: string;
      /** Where directory events go: the projects subscribed to each kind. */
      projectEvents: Pick<ProjectEventsService, "appendToSubscribers">;
      /** Groups referenced by project directory mappings. */
      mappedGroups: () => Promise<string[]>;
      /** Apply directory group membership to project roles. */
      reconcileRoles: (args: {
        userId: string;
        groups: readonly string[];
      }) => Promise<void>;
      /** Stop the account's live work (agent turns, runners). */
      onDisabled: (args: { userId: string }) => Promise<void>;
      /** A reason this account may never hold OAuth tokens (guests). */
      refuseTokens?: (userId: string) => Promise<string | undefined>;
      now?: () => Date;
      log?: (line: string) => void;
    },
  ) {
    this.directories = new Map(
      deps.directories.map((directory) => [directory.providerId, directory]),
    );
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** True unless the account is disabled. Checked on every request. */
  async isActive(userId: string): Promise<boolean> {
    const row = await this.deps.db
      .selectFrom("work_accounts")
      .select("disabled_at")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return !row?.disabled_at;
  }

  /**
   * Sign-in admission for one upstream account, before any Work server user
   * exists for it. Fails closed: an unreachable directory refuses sign-in.
   */
  async admitSignIn(args: {
    providerId: string;
    accountId: string;
    email: string;
  }): Promise<void> {
    const directory = this.directories.get(args.providerId);
    if (!directory) return;
    const status = await directory.check({
      accountId: args.accountId,
      email: args.email,
      groups: [],
    });
    if (!status.active) {
      throw new Error(`This account is ${status.reason.replaceAll("_", " ")}`);
    }
  }

  /**
   * Ask every directory governing the user; disable on a definitive no.
   * `force` asks now regardless of the check interval; `signIn` marks a
   * fresh sign-in, the only path that re-enables a disabled account.
   */
  async refreshStanding(args: {
    userId: string;
    force?: boolean;
    signIn?: boolean;
  }): Promise<AccountStanding> {
    return withSpan(
      {
        tracer,
        name: "work.account.standing",
        attributes: { "user.id": args.userId },
      },
      () => this.refreshStandingUninstrumented(args),
    );
  }

  private async refreshStandingUninstrumented(args: {
    userId: string;
    force?: boolean;
    signIn?: boolean;
  }): Promise<AccountStanding> {
    const now = this.now();
    const row = await this.deps.db
      .selectFrom("work_accounts")
      .selectAll()
      .where("user_id", "=", args.userId)
      .executeTakeFirst();
    const accounts = (
      await this.deps.auth.accountsFor({ userId: args.userId })
    ).filter((account) => this.directories.has(account.providerId));
    if (accounts.length === 0) {
      if (row?.disabled_at) return "disabled";
      // Without a directory an account joins at its first sign-in and
      // never leaves on its own.
      if (args.signIn && !row?.joined_at) {
        const { announcement } = await this.recordStanding({
          user: await this.deps.auth.findUserById({ userId: args.userId }),
          userId: args.userId,
          now,
          signIn: true,
        });
        await this.deliverQueued(announcement);
      }
      return "active";
    }
    const checkedAt = row?.directory_checked_at?.getTime() ?? 0;
    if (
      !args.force &&
      !row?.disabled_at &&
      now.getTime() - checkedAt < this.deps.directory.checkIntervalMs
    ) {
      return "active";
    }
    const user = await this.deps.auth.findUserById({ userId: args.userId });
    const mapped = [
      ...new Set(
        [
          ...(await this.deps.mappedGroups()),
          ...(await this.subscribedGroups()),
        ].map(normalizeGroup),
      ),
    ];
    const groups = new Set<string>();
    try {
      for (const account of accounts) {
        const directory = this.directories.get(account.providerId);
        if (!directory) continue;
        const status = await directory.check({
          accountId: account.accountId,
          email: user?.email ?? "",
          groups: mapped,
        });
        if (!status.active) {
          await this.disable({ userId: args.userId, reason: status.reason });
          return "disabled";
        }
        for (const group of status.groups) groups.add(normalizeGroup(group));
      }
    } catch (error) {
      if (!(error instanceof DirectoryUnavailableError)) throw error;
      this.deps.log?.(
        `Directory check for ${args.userId} failed: ${error.message}`,
      );
      if (row?.disabled_at) return "disabled";
      return now.getTime() - checkedAt <= this.deps.directory.graceMs
        ? "active_within_grace"
        : "unknown";
    }
    const { disabled, announcement } = await this.recordStanding({
      user,
      userId: args.userId,
      now,
      signIn: args.signIn ?? false,
      directory: { groups: [...groups], tracked: mapped },
    });
    if (disabled) return "disabled";
    await this.deps.reconcileRoles({
      userId: args.userId,
      groups: [...groups],
    });
    await this.deliverQueued(announcement);
    return "active";
  }

  /**
   * Record an approving directory answer (or, without a directory, a
   * sign-in) and the transition it makes, with its queued event, in one
   * transaction under the account's row lock: concurrent checks of one
   * account record each transition once. Answers whether the account
   * stays disabled, and the event to deliver once this commits.
   */
  private async recordStanding(args: {
    user: WorkAuthUser | null;
    userId: string;
    now: Date;
    signIn: boolean;
    /** The directory's groups, and the groups it was asked about. */
    directory?: { groups: readonly string[]; tracked: readonly string[] };
  }): Promise<{ disabled: boolean; announcement?: string }> {
    const { now } = args;
    return this.deps.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("work_accounts")
        .values({ user_id: args.userId, updated_at: now })
        .onConflict((conflict) => conflict.column("user_id").doNothing())
        .execute();
      const row = await trx
        .selectFrom("work_accounts")
        .selectAll()
        .where("user_id", "=", args.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      // Only a fresh sign-in the directory approves re-enables an account;
      // a background check racing a disable never undoes it.
      const disabled = !args.signIn && Boolean(row.disabled_at);
      const joins = args.signIn && (!row.joined_at || Boolean(row.disabled_at));
      const before = groupList(row.directory_groups);
      const groups = args.directory ? groupList(args.directory.groups) : before;
      // A group the server starts or stops asking about is not a change in
      // the member's groups: compare only groups asked about both times.
      const trackedBefore = new Set(groupList(row.directory_tracked_groups));
      const compared = new Set(
        groupList(args.directory?.tracked).filter((group) =>
          trackedBefore.has(group),
        ),
      );
      const added = groups.filter(
        (group) => compared.has(group) && !before.includes(group),
      );
      const removed = before.filter(
        (group) => compared.has(group) && !groups.includes(group),
      );
      const kind: DirectoryEventKind | undefined = joins
        ? "directory.member-joined"
        : !disabled && row.joined_at && added.length + removed.length > 0
          ? "directory.groups-changed"
          : undefined;
      const revision = row.lifecycle_revision + (kind ? 1 : 0);
      await trx
        .updateTable("work_accounts")
        .set({
          ...(args.directory
            ? {
                directory_checked_at: now,
                directory_groups: JSON.stringify(groups),
                directory_tracked_groups: JSON.stringify(
                  groupList(args.directory.tracked),
                ),
              }
            : {}),
          ...(args.signIn ? { disabled_at: null, disabled_reason: null } : {}),
          ...(joins ? { joined_at: now } : {}),
          lifecycle_revision: revision,
          updated_at: now,
        })
        .where("user_id", "=", args.userId)
        .execute();
      const announcement = kind
        ? await this.queueAnnouncement({
            transaction: trx,
            user: args.user,
            userId: args.userId,
            revision,
            occurredAt: now,
            ...(kind === "directory.groups-changed"
              ? { kind, groups, added, removed }
              : { kind, groups }),
          })
        : undefined;
      return { disabled, ...(announcement ? { announcement } : {}) };
    });
  }

  /**
   * Queue one transition's event in the transaction that records the
   * transition, so it exists exactly when the transition does. Reaching the
   * subscribed projects happens after commit ({@link deliverAnnouncements}):
   * a failure there never undoes the transition. An account without a user
   * record names nobody, so it announces nothing. Answers the event's
   * external id.
   */
  private async queueAnnouncement(
    args: {
      transaction: Transaction<DB>;
      user: WorkAuthUser | null;
      userId: string;
      revision: number;
      occurredAt: Date;
      groups: readonly string[];
    } & (
      | { kind: "directory.member-joined" | "directory.member-left" }
      | {
          kind: "directory.groups-changed";
          added: readonly string[];
          removed: readonly string[];
        }
    ),
  ): Promise<string | undefined> {
    if (!args.user) {
      this.deps.log?.(
        `No user record for ${args.userId}; ${args.kind} not announced`,
      );
      return undefined;
    }
    const member: DirectoryMember = {
      id: args.userId,
      email: args.user.email,
      name: args.user.name || null,
    };
    const event = directoryProjectEvent(
      args.kind === "directory.groups-changed"
        ? {
            kind: args.kind,
            member,
            groups: args.groups,
            added: args.added,
            removed: args.removed,
            occurredAt: args.occurredAt,
            revision: args.revision,
          }
        : {
            kind: args.kind,
            member,
            groups: args.groups,
            occurredAt: args.occurredAt,
            revision: args.revision,
          },
    );
    await args.transaction
      .insertInto("work_directory_announcements")
      .values({
        tenant_id: this.deps.tenantId,
        user_id: args.userId,
        revision: args.revision,
        kind: event.kind,
        external_id: event.externalId,
        occurred_at: new Date(event.occurredAt),
        payload: event.payload,
      })
      .onConflict((conflict) => conflict.column("external_id").doNothing())
      .execute();
    return event.externalId;
  }

  /**
   * Deliver queued directory events to every project subscribed to their
   * kind (ADR 0210). Each event is claimed under `SKIP LOCKED`, appended to
   * its projects and removed in one transaction, so replicas share the
   * queue and none is delivered twice. One that fails waits and retries
   * with backoff; it holds back only the same account's later events.
   * Hosts call this on a timer; a transition also delivers its own event
   * as soon as it commits.
   */
  async deliverAnnouncements(
    input: { limit?: number } = {},
  ): Promise<{ delivered: number; failed: number }> {
    return withSpan(
      { tracer, name: "work.directory.deliver_announcements" },
      async (span) => {
        let delivered = 0;
        let failed = 0;
        for (let pass = 0; pass < (input.limit ?? 100); pass++) {
          const outcome = await this.deliverOne({});
          if (outcome === "none") break;
          if (outcome === "delivered") delivered += 1;
          else failed += 1;
        }
        span.setAttribute("catamorphic.directory.delivered", delivered);
        span.setAttribute("catamorphic.directory.failed", failed);
        return { delivered, failed };
      },
    );
  }

  /**
   * Deliver the event a transition just queued, after its transaction
   * committed. Never throws: an event that cannot be delivered now stays
   * queued for {@link deliverAnnouncements}.
   */
  private async deliverQueued(externalId: string | undefined): Promise<void> {
    if (!externalId) return;
    await this.deliverOne({ externalId }).catch((error) =>
      this.deps.log?.(
        `Directory event ${externalId} stays queued: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }

  /** Deliver one due queued event, or report that none is due. */
  private async deliverOne(input: {
    externalId?: string;
  }): Promise<"delivered" | "failed" | "none"> {
    // The row this attempt holds, so a failure can be recorded after the
    // delivery transaction rolled back.
    let claimed:
      | { id: string; externalId: string; attempts: number }
      | undefined;
    try {
      return await this.deps.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("work_directory_announcements as event")
          .selectAll("event")
          .where("event.next_attempt_at", "<=", sql<Date>`now()`)
          .$if(input.externalId !== undefined, (query) =>
            query.where("event.external_id", "=", input.externalId ?? ""),
          )
          // One account's events go in order: an earlier one still
          // waiting holds the later ones back.
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("work_directory_announcements as earlier")
                  .select("earlier.id")
                  .whereRef("earlier.user_id", "=", "event.user_id")
                  .whereRef("earlier.revision", "<", "event.revision"),
              ),
            ),
          )
          .orderBy("event.created_at")
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return "none";
        claimed = {
          id: row.id,
          externalId: row.external_id,
          attempts: row.attempts,
        };
        await this.deps.projectEvents.appendToSubscribers({
          tenantId: row.tenant_id,
          source: DIRECTORY_EVENT_SOURCE,
          kind: row.kind,
          externalId: row.external_id,
          occurredAt: row.occurred_at.toISOString(),
          payload: jsonObject(row.payload),
          transaction: trx,
        });
        await trx
          .deleteFrom("work_directory_announcements")
          .where("id", "=", row.id)
          .execute();
        return "delivered";
      });
    } catch (error) {
      if (!claimed) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const { attempts } = claimed;
      await this.deps.db
        .updateTable("work_directory_announcements")
        .set({
          attempts: attempts + 1,
          last_error: message,
          next_attempt_at: sql<Date>`now() + make_interval(secs => ${Math.min(
            300,
            2 ** attempts,
          )})`,
        })
        .where("id", "=", claimed.id)
        .execute();
      this.deps.log?.(
        `Directory event ${claimed.externalId} did not reach its projects (attempt ${attempts + 1}): ${message}`,
      );
      return "failed";
    }
  }

  /**
   * Groups named by active directory trigger bindings (`{ groups }`
   * config): the directory is asked about them so those bindings can
   * select by them.
   */
  private async subscribedGroups(): Promise<string[]> {
    const rows = await this.deps.db
      .selectFrom("workflow_enablement_triggers as activation")
      .innerJoin(
        "workflow_enablements as enablement",
        "enablement.id",
        "activation.enablement_id",
      )
      .innerJoin(
        "trigger_definitions as definition",
        "definition.id",
        "activation.trigger_definition_id",
      )
      .select("definition.config")
      .where("enablement.tenant_id", "=", this.deps.tenantId)
      .where("definition.trigger_kind", "in", [...DIRECTORY_EVENT_KINDS])
      .where("activation.status", "=", "active")
      .where("enablement.status", "=", "active")
      .execute();
    return rows.flatMap((row) =>
      row.config && typeof row.config === "object" && "groups" in row.config
        ? groupList(row.config.groups)
        : [],
    );
  }

  /** Revoke every credential and stop live work. Idempotent. */
  async disable(args: { userId: string; reason: string }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "work.account.disable",
        attributes: {
          "user.id": args.userId,
          "work.account.reason": args.reason,
        },
      },
      async () => {
        const now = this.now();
        const user = await this.deps.auth.findUserById({
          userId: args.userId,
        });
        const announcement = await this.deps.db
          .transaction()
          .execute(async (trx) => {
            await trx
              .insertInto("work_accounts")
              .values({ user_id: args.userId, updated_at: now })
              .onConflict((conflict) => conflict.column("user_id").doNothing())
              .execute();
            const row = await trx
              .selectFrom("work_accounts")
              .select([
                "disabled_at",
                "joined_at",
                "lifecycle_revision",
                "directory_groups",
              ])
              .where("user_id", "=", args.userId)
              .forUpdate()
              .executeTakeFirstOrThrow();
            // A member leaves once: an account that never joined, or is
            // already disabled, has nothing to announce.
            const leaves = Boolean(row.joined_at) && !row.disabled_at;
            const revision = row.lifecycle_revision + (leaves ? 1 : 0);
            await trx
              .updateTable("work_accounts")
              .set({
                disabled_at: now,
                disabled_reason: args.reason,
                lifecycle_revision: revision,
                updated_at: now,
              })
              .where("user_id", "=", args.userId)
              .execute();
            // Only queued here: delivering it to projects happens after
            // commit, so offboarding never depends on that fan-out.
            return leaves
              ? this.queueAnnouncement({
                  transaction: trx,
                  kind: "directory.member-left",
                  user,
                  userId: args.userId,
                  revision,
                  occurredAt: now,
                  groups: groupList(row.directory_groups),
                })
              : undefined;
          });
        await this.deps.db
          .updateTable("work_token_families")
          .set({ revoked_at: now, revoked_reason: `account_${args.reason}` })
          .where("user_id", "=", args.userId)
          .where("revoked_at", "is", null)
          .execute();
        await this.deps.auth.signOutEverywhere({ userId: args.userId });
        await this.deps.onDisabled({ userId: args.userId });
        this.deps.log?.(`Disabled ${args.userId}: ${args.reason}`);
        await this.deliverQueued(announcement);
      },
    );
  }

  /** Gate a refresh grant before the authorization server honors it. */
  async beforeRefresh(args: {
    refreshToken: string;
    clientId?: string;
  }): Promise<GrantDecision> {
    const deny = (description: string): GrantDecision => ({
      allow: false,
      error: "invalid_grant",
      description,
    });
    const token = await this.deps.db
      .selectFrom("work_refresh_tokens as token")
      .innerJoin(
        "work_token_families as family",
        "family.id",
        "token.family_id",
      )
      .select([
        "token.rotated_at",
        "family.id as family_id",
        "family.user_id",
        "family.client_id",
        "family.expires_at",
        "family.revoked_at",
      ])
      .where("token.token_hash", "=", hashToken(args.refreshToken))
      .executeTakeFirst();
    if (!token) return deny("unknown refresh token");
    if (token.rotated_at) {
      // A rotated token came back: the family leaked. Revoke all of it.
      await this.revokeFamily({ familyId: token.family_id, reason: "reuse" });
      return deny("refresh token reuse detected");
    }
    if (token.revoked_at) return deny("session revoked");
    if (args.clientId && args.clientId !== token.client_id) {
      return deny("refresh token belongs to another client");
    }
    if (token.expires_at.getTime() <= this.now().getTime()) {
      await this.revokeFamily({ familyId: token.family_id, reason: "max_age" });
      return deny("session reached its maximum age; sign in again");
    }
    if (!(await this.isActive(token.user_id))) return deny("account disabled");
    const standing = await this.refreshStanding({ userId: token.user_id });
    if (standing === "disabled") return deny("account disabled");
    if (standing === "unknown") return deny("directory unavailable");
    // Claim the token in one statement: of two concurrent refreshes, one
    // wins and the other is reuse.
    const claimed = await this.deps.db
      .updateTable("work_refresh_tokens")
      .set({ rotated_at: this.now() })
      .where("token_hash", "=", hashToken(args.refreshToken))
      .where("rotated_at", "is", null)
      .returning("token_hash")
      .executeTakeFirst();
    if (!claimed) {
      await this.revokeFamily({ familyId: token.family_id, reason: "reuse" });
      return deny("refresh token reuse detected");
    }
    return { allow: true };
  }

  /**
   * Record a token response the authorization server produced. A code
   * exchange starts a family (after a fresh directory check, failing closed);
   * a refresh rotates within its family. A veto deletes the issued grant.
   */
  async afterGrant(args: {
    grantType: "authorization_code" | "refresh_token";
    previousRefreshToken?: string;
    response: TokenResponse;
  }): Promise<GrantDecision> {
    const accessToken = args.response.access_token;
    if (typeof accessToken !== "string") return { allow: true };
    const grant = await this.deps.auth.grantByAccessToken({ accessToken });
    if (!grant) return { allow: true };
    const refreshToken =
      typeof args.response.refresh_token === "string"
        ? args.response.refresh_token
        : undefined;
    const now = this.now();
    if (args.grantType === "authorization_code") {
      const refusal = await this.deps.refuseTokens?.(grant.userId);
      if (refusal) {
        await this.deps.auth.deleteGrants({ ids: [grant.id] });
        return { allow: false, error: "invalid_grant", description: refusal };
      }
      // Always ask afresh: a disabled account the directory now reports
      // active is re-enabled here, and nothing else is issued a family.
      const standing = await this.refreshStanding({
        userId: grant.userId,
        force: true,
        signIn: true,
      });
      if (standing !== "active") {
        await this.deps.auth.deleteGrants({ ids: [grant.id] });
        return {
          allow: false,
          error: "invalid_grant",
          description:
            standing === "disabled"
              ? "account disabled"
              : "directory unavailable",
        };
      }
      if (!refreshToken) return { allow: true };
      const family = await this.deps.db
        .insertInto("work_token_families")
        .values({
          user_id: grant.userId,
          client_id: grant.clientId,
          created_at: now,
          expires_at: new Date(
            now.getTime() + this.deps.sessions.maxAgeSeconds * 1000,
          ),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await this.recordToken({
        familyId: family.id,
        refreshToken,
        grantId: grant.id,
      });
      return { allow: true };
    }
    if (!args.previousRefreshToken || !refreshToken) return { allow: true };
    const previous = await this.deps.db
      .selectFrom("work_refresh_tokens as token")
      .innerJoin(
        "work_token_families as family",
        "family.id",
        "token.family_id",
      )
      .select(["token.family_id", "token.grant_id", "family.revoked_at"])
      .where("token.token_hash", "=", hashToken(args.previousRefreshToken))
      .executeTakeFirst();
    if (!previous || previous.revoked_at) {
      await this.deps.auth.deleteGrants({ ids: [grant.id] });
      return {
        allow: false,
        error: "invalid_grant",
        description: previous ? "session revoked" : "unknown refresh token",
      };
    }
    // The superseded pair stops working at once, not at its expiry.
    await this.deps.auth.deleteGrants({ ids: [previous.grant_id] });
    await this.recordToken({
      familyId: previous.family_id,
      refreshToken,
      grantId: grant.id,
    });
    return { allow: true };
  }

  /**
   * Check every account that still holds a live session, and every member
   * who joined and is not disabled, so a departure is noticed (and
   * announced, ADR 0210) whether or not they are signed in. The sweep
   * always asks the directory, so its interval bounds how long a departure
   * takes.
   */
  async sweep(): Promise<{ checked: number; disabled: number }> {
    let checked = 0;
    let disabled = 0;
    const members = await this.deps.db
      .selectFrom("work_accounts")
      .select("user_id")
      .where("joined_at", "is not", null)
      .where("disabled_at", "is", null)
      .execute();
    const userIds = new Set([
      ...(await this.deps.auth.usersSignedIn()),
      ...members.map((member) => member.user_id),
    ]);
    for (const userId of userIds) {
      try {
        const standing = await this.refreshStanding({ userId, force: true });
        checked += 1;
        if (standing === "disabled") disabled += 1;
      } catch (error) {
        this.deps.log?.(
          `Account sweep failed for ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { checked, disabled };
  }

  private async recordToken(args: {
    familyId: string;
    refreshToken: string;
    grantId: string;
  }): Promise<void> {
    await this.deps.db
      .insertInto("work_refresh_tokens")
      .values({
        token_hash: hashToken(args.refreshToken),
        family_id: args.familyId,
        grant_id: args.grantId,
      })
      .execute();
  }

  private async revokeFamily(args: {
    familyId: string;
    reason: string;
  }): Promise<void> {
    await this.deps.db
      .updateTable("work_token_families")
      .set({ revoked_at: this.now(), revoked_reason: args.reason })
      .where("id", "=", args.familyId)
      .where("revoked_at", "is", null)
      .execute();
    const tokens = await this.deps.db
      .selectFrom("work_refresh_tokens")
      .select("grant_id")
      .where("family_id", "=", args.familyId)
      .execute();
    await this.deps.auth.deleteGrants({
      ids: tokens.map((token) => token.grant_id),
    });
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A queued event's payload, which is always the object it was built as. */
function jsonObject(value: Json): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("A queued directory event's payload must be an object");
  return value;
}

/** Stored or reported groups as one normalized, sorted list. */
function groupList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((group): group is string => typeof group === "string")
        .map(normalizeGroup),
    ),
  ].sort();
}
