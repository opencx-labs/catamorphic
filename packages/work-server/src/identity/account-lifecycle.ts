import { createHash } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import type {
  WorkDirectoryPolicy,
  WorkSessionPolicy,
} from "../auth/auth-config.js";
import type { WorkAuth } from "../auth/work-auth.js";
import {
  type DirectoryProvider,
  DirectoryUnavailableError,
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
 */
export class AccountLifecycle {
  private readonly directories: Map<string, DirectoryProvider>;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      auth: WorkAuth;
      directories: readonly DirectoryProvider[];
      sessions: WorkSessionPolicy;
      directory: WorkDirectoryPolicy;
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
      return row?.disabled_at ? "disabled" : "active";
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
    const mapped = await this.deps.mappedGroups();
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
        for (const group of status.groups) groups.add(group);
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
    await this.deps.db
      .insertInto("work_accounts")
      .values({
        user_id: args.userId,
        directory_checked_at: now,
        directory_groups: JSON.stringify([...groups]),
        disabled_at: null,
        disabled_reason: null,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("user_id").doUpdateSet({
          directory_checked_at: now,
          directory_groups: JSON.stringify([...groups]),
          // Only a fresh sign-in the directory approves re-enables an
          // account; a background check racing a disable never undoes it.
          ...(args.signIn ? { disabled_at: null, disabled_reason: null } : {}),
          updated_at: now,
        }),
      )
      .execute();
    if (!args.signIn && row?.disabled_at) return "disabled";
    await this.deps.reconcileRoles({
      userId: args.userId,
      groups: [...groups],
    });
    return "active";
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
        await this.deps.db
          .insertInto("work_accounts")
          .values({
            user_id: args.userId,
            disabled_at: now,
            disabled_reason: args.reason,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("user_id").doUpdateSet({
              disabled_at: now,
              disabled_reason: args.reason,
              updated_at: now,
            }),
          )
          .execute();
        await this.deps.db
          .updateTable("work_token_families")
          .set({ revoked_at: now, revoked_reason: `account_${args.reason}` })
          .where("user_id", "=", args.userId)
          .where("revoked_at", "is", null)
          .execute();
        await this.deps.auth.signOutEverywhere({ userId: args.userId });
        await this.deps.onDisabled({ userId: args.userId });
        this.deps.log?.(`Disabled ${args.userId}: ${args.reason}`);
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
   * Check every account that still holds a live session. The sweep always
   * asks the directory, so its interval bounds how long a departure takes.
   */
  async sweep(): Promise<{ checked: number; disabled: number }> {
    let checked = 0;
    let disabled = 0;
    for (const userId of await this.deps.auth.usersSignedIn()) {
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
