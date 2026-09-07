import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { type ObjectStore, PreconditionFailedError } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";

const tracer = getTracer("@catamorphic/server-sdk");

/** Shared binary storage with atomic compare-and-swap, supplied by the host. */
export class PostgresObjectStore implements ObjectStore {
  constructor(private readonly db: Kysely<DB>) {}

  async get(key: string): Promise<{ data: Uint8Array; etag: string } | null> {
    const row = await this.db
      .selectFrom("stored_objects")
      .select(["data", "etag"])
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? { data: new Uint8Array(row.data), etag: row.etag } : null;
  }

  async has(key: string): Promise<boolean> {
    return Boolean(
      await this.db
        .selectFrom("stored_objects")
        .select("key")
        .where("key", "=", key)
        .executeTakeFirst(),
    );
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { ifMatch?: string; ifNoneMatch?: "*" },
  ): Promise<void> {
    if (opts?.ifMatch !== undefined && opts.ifNoneMatch !== undefined) {
      throw new Error("Use one object write precondition");
    }
    await withSpan(
      {
        tracer,
        name: "storage.object.put",
        attributes: {
          "catamorphic.storage.bytes": data.byteLength,
        },
      },
      async () => {
        const values = {
          data: Buffer.from(data),
          etag: randomUUID(),
          updated_at: new Date(),
        };
        if (opts?.ifMatch !== undefined) {
          const changed = await this.db
            .updateTable("stored_objects")
            .set(values)
            .where("key", "=", key)
            .where("etag", "=", opts.ifMatch)
            .returning("key")
            .executeTakeFirst();
          if (!changed) throw new PreconditionFailedError(key);
          return;
        }
        const changed = await this.db
          .insertInto("stored_objects")
          .values({ key, ...values })
          .onConflict((oc) =>
            opts?.ifNoneMatch === "*"
              ? oc.column("key").doNothing()
              : oc.column("key").doUpdateSet(values),
          )
          .returning("key")
          .executeTakeFirst();
        if (!changed) throw new PreconditionFailedError(key);
      },
    );
  }

  async list(prefix: string): Promise<string[]> {
    return (
      await this.db
        .selectFrom("stored_objects")
        .select("key")
        .where(sql<boolean>`starts_with(key, ${prefix})`)
        .orderBy("key")
        .execute()
    ).map((row) => row.key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.db
      .deleteFrom("stored_objects")
      .where(sql<boolean>`starts_with(key, ${prefix})`)
      .execute();
  }
}
