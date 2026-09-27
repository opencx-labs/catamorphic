import type { ControlPlanePermission, Identity } from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { WorkAuth, WorkAuthUser } from "../auth/work-auth.js";

/**
 * What an organization administrator holds beyond their project roles
 * (ADR 0172): the host-issued connections permissions, so they create,
 * authorize, rotate, and revoke the organization's service connections.
 * Project roles never grant these (ADR 0158).
 */
export const ADMINISTRATOR_PERMISSIONS: readonly ControlPlanePermission[] = [
  "connections:read",
  "connections:write",
];

export class LastAdministratorError extends Error {
  constructor() {
    super("The organization keeps at least one administrator");
    this.name = "LastAdministratorError";
  }
}

export interface WorkAdministrator {
  userId: string;
  email: string | null;
  name: string | null;
}

/**
 * Work server organization administrators: a flag on the account, set by
 * the operator for the first ones and by any administrator after that.
 */
export class WorkAdministrators {
  constructor(
    private readonly options: {
      db: Kysely<DB>;
      auth: Pick<WorkAuth, "findUserById" | "findUserByEmail">;
    },
  ) {}

  async isAdministrator(userId: string): Promise<boolean> {
    const row = await this.options.db
      .selectFrom("work_accounts")
      .select("administrator")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return row?.administrator === true;
  }

  /** The identity with its administrator permissions, when it holds them. */
  async withPermissions(identity: Identity): Promise<Identity> {
    return (await this.isAdministrator(identity.externalUserId))
      ? { ...identity, controlPlanePermissions: ADMINISTRATOR_PERMISSIONS }
      : identity;
  }

  async list(): Promise<WorkAdministrator[]> {
    const rows = await this.options.db
      .selectFrom("work_accounts")
      .select("user_id")
      .where("administrator", "=", true)
      .orderBy("user_id")
      .execute();
    return Promise.all(
      rows.map(async (row) => {
        const user = await this.options.auth.findUserById({
          userId: row.user_id,
        });
        return {
          userId: row.user_id,
          email: user?.email ?? null,
          name: user?.name ?? null,
        };
      }),
    );
  }

  /** Promote a user who has signed in at least once, found by email. */
  async promote(args: { email: string }): Promise<WorkAuthUser> {
    const user = await this.options.auth.findUserByEmail({
      email: args.email,
    });
    if (!user?.emailVerified) {
      throw new Error(
        "No user with that verified email has signed in yet. Ask them to sign in once, then retry.",
      );
    }
    await this.set({ userId: user.id, administrator: true });
    return user;
  }

  /**
   * Set or clear the flag. Clearing refuses to leave the organization
   * without an administrator unless `allowNone` (the operator may).
   */
  async set(args: {
    userId: string;
    administrator: boolean;
    allowNone?: boolean;
  }): Promise<void> {
    await this.options.db.transaction().execute(async (trx) => {
      if (!args.administrator && !args.allowNone) {
        const others = await trx
          .selectFrom("work_accounts")
          .select("user_id")
          .where("administrator", "=", true)
          .where("user_id", "!=", args.userId)
          .forUpdate()
          .execute();
        if (others.length === 0) throw new LastAdministratorError();
      }
      await trx
        .insertInto("work_accounts")
        .values({ user_id: args.userId, administrator: args.administrator })
        .onConflict((oc) =>
          oc.column("user_id").doUpdateSet({
            administrator: args.administrator,
            updated_at: new Date(),
          }),
        )
        .execute();
    });
  }
}
