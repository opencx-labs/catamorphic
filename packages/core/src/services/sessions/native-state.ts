import type { JsonValue } from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * A provider thread's native state, stored with Work (ADR 0198): Claude
 * Code's session transcript through its SessionStore, a Codex rollout, the
 * built-in agent's history. Entries keep their order; one carrying a
 * `uuid` is stored once, so a retried append never duplicates it.
 */
export class NativeStateStore {
  constructor(private readonly db: Kysely<DB>) {}

  async append(input: {
    threadId: string;
    subpath?: string;
    entries: readonly JsonValue[];
    executor?: Executor;
  }): Promise<void> {
    if (input.entries.length === 0) return;
    const db = input.executor ?? this.db;
    const subpath = input.subpath ?? "";
    const last = await db
      .selectFrom("agent_provider_thread_entries")
      .select((eb) => eb.fn.max("seq").as("seq"))
      .where("thread_id", "=", input.threadId)
      .where("subpath", "=", subpath)
      .executeTakeFirst();
    let seq = Number(last?.seq ?? 0);
    await db
      .insertInto("agent_provider_thread_entries")
      .values(
        input.entries.map((entry) => {
          seq += 1;
          const uuid =
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            typeof entry.uuid === "string"
              ? entry.uuid
              : null;
          return {
            thread_id: input.threadId,
            subpath,
            seq,
            entry_uuid: uuid,
            entry: entry as Json,
          };
        }),
      )
      .onConflict((conflict) =>
        conflict
          .columns(["thread_id", "subpath", "entry_uuid"])
          .where("entry_uuid", "is not", null)
          .doNothing(),
      )
      .execute();
    await db
      .updateTable("agent_provider_threads")
      .set({ portable: true, updated_at: sql`now()` })
      .where("id", "=", input.threadId)
      .where("portable", "=", false)
      .execute();
  }

  /** The entries in order, or null when the thread has none at that subpath. */
  async load(input: {
    threadId: string;
    subpath?: string;
  }): Promise<JsonValue[] | null> {
    const rows = await this.db
      .selectFrom("agent_provider_thread_entries")
      .select("entry")
      .where("thread_id", "=", input.threadId)
      .where("subpath", "=", input.subpath ?? "")
      .orderBy("seq")
      .execute();
    return rows.length === 0 ? null : rows.map((row) => row.entry as JsonValue);
  }

  async subpaths(input: { threadId: string }): Promise<string[]> {
    const rows = await this.db
      .selectFrom("agent_provider_thread_entries")
      .select("subpath")
      .distinct()
      .where("thread_id", "=", input.threadId)
      .where("subpath", "!=", "")
      .execute();
    return rows.map((row) => row.subpath);
  }

  /** Whether the thread's state is stored at all (so it can resume anywhere). */
  async has(input: { threadId: string }): Promise<boolean> {
    const row = await this.db
      .selectFrom("agent_provider_thread_entries")
      .select("thread_id")
      .where("thread_id", "=", input.threadId)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }
}
