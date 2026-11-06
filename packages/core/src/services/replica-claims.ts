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

/** A held claim lapsed or moved while its work ran; the work stops. */
export class ReplicaClaimLostError extends Error {
  constructor(readonly claim: string) {
    super(
      `'${claim}' was taken over while its work ran; nothing more was done`,
    );
    this.name = "ReplicaClaimLostError";
  }
}

/** What a claimed operation sees of its claim. */
export interface HeldReplicaClaim {
  /** Aborts once the claim is lost: check it before each write. */
  signal: AbortSignal;
}

/**
 * Run `operation` while holding the claim `name`, so no other process (and
 * no other call in this one) runs it at once (ADR 0193). The claim is
 * renewed while the operation runs and released after it; a process that
 * dies holding it frees it once it lapses. Waits up to `waitMs` (default:
 * not at all) for a held claim, then throws {@link ReplicaClaimBusyError}.
 *
 * Once the claim could be lost (no renewal landed in time: aborted exactly at
 * the deadline, before the database lets another process take it) or is
 * found lost by a renewal, `signal` aborts and the call rejects with
 * {@link ReplicaClaimLostError}, even if the operation ignores the signal.
 * Operations check the signal before each write that must stay exclusive.
 */
export async function withReplicaClaim<T>(input: {
  db: Kysely<DB>;
  name: string;
  ttlSeconds?: number;
  waitMs?: number;
  pollMs?: number;
  operation: (claim: HeldReplicaClaim) => Promise<T>;
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
      const lost = new AbortController();
      let lose = (_error: ReplicaClaimLostError) => {};
      const abandoned = new Promise<never>((_resolve, reject) => {
        lose = reject;
      });
      abandoned.catch(() => {});
      const loseClaim = () => {
        if (lost.signal.aborted) return;
        const error = new ReplicaClaimLostError(input.name);
        span.setAttribute("catamorphic.claim.lost", true);
        lost.abort(error);
        lose(error);
      };
      // Measured from each renewal's dispatch: a hung renewal cannot keep
      // the work going past the claim's expiry.
      // The work stops the moment its claim could lapse: the expiry timer is
      // set from each landed renewal's dispatch, never later than the
      // database's own expiry, so no other process can take the claim
      // while the work still runs.
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const holdUntil = (deadline: number) => {
        clearTimeout(expiry);
        expiry = setTimeout(
          loseClaim,
          Math.max(0, deadline - performance.now()),
        );
        expiry.unref();
      };
      holdUntil(performance.now() + ttlSeconds * 1_000);
      let renewing: Promise<unknown> | undefined;
      const renewal = setInterval(
        () => {
          if (renewing || lost.signal.aborted) return;
          const dispatched = performance.now();
          renewing = renewReplicaClaim({
            db: input.db,
            name: input.name,
            holder,
            ttlSeconds,
          })
            .then((held) => {
              if (held && !lost.signal.aborted)
                holdUntil(dispatched + ttlSeconds * 1_000);
              else loseClaim();
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
        Math.max(250, Math.floor((ttlSeconds * 1_000) / 4)),
      );
      renewal.unref();
      try {
        return await Promise.race([
          input.operation({ signal: lost.signal }),
          abandoned,
        ]);
      } finally {
        clearInterval(renewal);
        clearTimeout(expiry);
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
