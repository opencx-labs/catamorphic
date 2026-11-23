import { type DB, type Json, jsonbText } from "@catamorphic/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";

/** A wait keeps this long: after it, its id names nothing. */
export const SESSION_WAIT_TTL_MS = 24 * 60 * 60 * 1_000;

const Watched = z.array(
  z.object({
    projectId: z.string(),
    sessionId: z.string(),
    after: z.number().int().nonnegative().optional(),
  }),
);

/** One chat a wait watches, from the log position its caller saw. */
export type WatchedSession = z.infer<typeof Watched>[number];

/** A wait as its caller reads it. */
export interface SessionWait {
  id: string;
  sessions: WatchedSession[];
  status: "working" | "completed" | "cancelled";
  /** What the wait came to; set once, with `completed`. */
  outcome: Json | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/**
 * Waits their callers left running (ADR 0347), in Postgres: a caller that
 * cannot hold a call open starts one, and reads on any replica, after any
 * restart, what it came to. Each belongs to the member who started it;
 * its outcome is written once and never changes. Nothing here watches:
 * whoever reads a wait looks at its chats then.
 */
export class SessionWaitsService {
  constructor(private readonly db: Kysely<DB>) {}

  async create(input: {
    identity: Identity;
    sessions: readonly WatchedSession[];
    ttlMs?: number;
  }): Promise<SessionWait> {
    // Waits nobody can read any more go as new ones come.
    await this.db
      .deleteFrom("session_waits")
      .where("expires_at", "<=", sql<Date>`now()`)
      .execute();
    const row = await this.db
      .insertInto("session_waits")
      .values({
        tenant_id: input.identity.tenantId,
        external_user_id: input.identity.externalUserId,
        sessions: jsonbText(input.sessions),
        expires_at: new Date(Date.now() + (input.ttlMs ?? SESSION_WAIT_TTL_MS)),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return waitFromRow(row);
  }

  /** The caller's own wait, while it lasts; another member's is no wait. */
  async get(input: {
    identity: Identity;
    id: string;
  }): Promise<SessionWait | undefined> {
    if (!z.string().uuid().safeParse(input.id).success) return undefined;
    const row = await this.db
      .selectFrom("session_waits")
      .selectAll()
      .where("id", "=", input.id)
      .where("tenant_id", "=", input.identity.tenantId)
      .where("external_user_id", "=", input.identity.externalUserId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    return row ? waitFromRow(row) : undefined;
  }

  /**
   * Record what a working wait came to. Whoever gets there first writes
   * it; everyone reads the same outcome after.
   */
  async complete(input: {
    identity: Identity;
    id: string;
    outcome: unknown;
  }): Promise<SessionWait | undefined> {
    await this.db
      .updateTable("session_waits")
      .set({
        status: "completed",
        outcome: jsonbText(input.outcome),
        updated_at: new Date(),
      })
      .where("id", "=", input.id)
      .where("tenant_id", "=", input.identity.tenantId)
      .where("external_user_id", "=", input.identity.externalUserId)
      .where("status", "=", "working")
      .execute();
    return this.get(input);
  }

  /** Stop a working wait. Its chats are untouched: only the watching ends. */
  async cancel(input: {
    identity: Identity;
    id: string;
  }): Promise<SessionWait | undefined> {
    await this.db
      .updateTable("session_waits")
      .set({ status: "cancelled", updated_at: new Date() })
      .where("id", "=", input.id)
      .where("tenant_id", "=", input.identity.tenantId)
      .where("external_user_id", "=", input.identity.externalUserId)
      .where("status", "=", "working")
      .execute();
    return this.get(input);
  }
}

function waitFromRow(row: {
  id: string;
  sessions: Json;
  status: string;
  outcome: Json | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}): SessionWait {
  const sessions = Watched.safeParse(row.sessions);
  return {
    id: row.id,
    sessions: sessions.success ? sessions.data : [],
    status:
      row.status === "completed" || row.status === "cancelled"
        ? row.status
        : "working",
    outcome: row.outcome,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
