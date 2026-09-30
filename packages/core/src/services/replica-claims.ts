import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";

const tracer = getTracer("@catamorphic/core");

/** A named claim is held by someone else and did not free up in time. */
export class ReplicaClaimBusyError extends Error {
  constructor(readonly claim: string) {
    super(`'${claim}' is in progress elsewhere; try again shortly`);
    this.name = "ReplicaClaimBusyError";
  }
}

/**
 * Take the claim `name` for `ttlSeconds` (ADR 0193): true when it was free
 * or had lapsed. A claim that is never released is a schedule: nobody, its
 * holder included, takes it again until it lapses.
 */
export async function takeReplicaClaim(input: {
  db: Kysely<DB>;
  name: string;
  holder: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const row = await input.db
    .insertInto("replica_claims")
    .values({
      name: input.name,
      holder: input.holder,
      expires_at: sql<Date>`now() + (${input.ttlSeconds} * interval '1 second')`,
    })
    .onConflict((conflict) =>
      conflict
        .column("name")
        .doUpdateSet(({ ref }) => ({
          holder: ref("excluded.holder"),
          expires_at: ref("excluded.expires_at"),
        }))
        .where(({ eb, ref }) =>
          eb(ref("replica_claims.expires_at"), "<=", sql<Date>`now()`),
        ),
    )
    .returning("holder")
    .executeTakeFirst();
  return row?.holder === input.holder;
}

/** Extend a claim `holder` still has; false once it lapsed or moved. */
export async function renewReplicaClaim(input: {
  db: Kysely<DB>;
  name: string;
  holder: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const result = await input.db
    .updateTable("replica_claims")
    .set({
      expires_at: sql<Date>`now() + (${input.ttlSeconds} * interval '1 second')`,
    })
    .where("name", "=", input.name)
    .where("holder", "=", input.holder)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** Give a claim back, if `holder` still has it. */
export async function releaseReplicaClaim(input: {
  db: Kysely<DB>;
  name: string;
  holder: string;
}): Promise<void> {
  await input.db
    .deleteFrom("replica_claims")
    .where("name", "=", input.name)
    .where("holder", "=", input.holder)
    .execute();
}

/**
 * Run `operation` while holding the claim `name`, so no other process (and
 * no other call in this one) runs it at once (ADR 0193). The claim is
 * renewed while the operation runs and released after it; a process that
 * dies holding it frees it once it lapses. Waits up to `waitMs` (default:
 * not at all) for a held claim, then throws {@link ReplicaClaimBusyError}.
 */
export async function withReplicaClaim<T>(input: {
  db: Kysely<DB>;
  name: string;
  ttlSeconds?: number;
  waitMs?: number;
  pollMs?: number;
  operation: () => Promise<T>;
}): Promise<T> {
  const ttlSeconds = input.ttlSeconds ?? 60;
  const holder = randomUUID();
  return withSpan(
    {
      tracer,
      name: "replica_claim.hold",
      attributes: { "catamorphic.claim.name": input.name },
    },
    async (span) => {
      const deadline = Date.now() + (input.waitMs ?? 0);
      let waited = false;
      while (
        !(await takeReplicaClaim({
          db: input.db,
          name: input.name,
          holder,
          ttlSeconds,
        }))
      ) {
        if (Date.now() >= deadline) throw new ReplicaClaimBusyError(input.name);
        waited = true;
        await new Promise((resolve) =>
          setTimeout(resolve, input.pollMs ?? 200),
        );
      }
      span.setAttribute("catamorphic.claim.waited", waited);
      let renewing: Promise<unknown> | undefined;
      const renewal = setInterval(
        () => {
          renewing ??= renewReplicaClaim({
            db: input.db,
            name: input.name,
            holder,
            ttlSeconds,
          })
            .then((held) => {
              if (!held)
                console.warn(
                  `[catamorphic] The claim '${input.name}' lapsed while its work ran`,
                );
            })
            .catch((error: unknown) =>
              console.warn(
                `[catamorphic] Could not renew the claim '${input.name}'`,
                error,
              ),
            )
            .finally(() => {
              renewing = undefined;
            });
        },
        Math.max(1_000, Math.floor((ttlSeconds * 1_000) / 3)),
      );
      renewal.unref();
      try {
        return await input.operation();
      } finally {
        clearInterval(renewal);
        await renewing;
        await releaseReplicaClaim({
          db: input.db,
          name: input.name,
          holder,
        }).catch((error: unknown) =>
          console.warn(
            `[catamorphic] Could not release the claim '${input.name}'`,
            error,
          ),
        );
      }
    },
  );
}
