import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";

export interface RateBucketKey {
  globalKey: string;
  partitionKey?: string;
}

export interface RateLimit {
  key: RateBucketKey;
  capacity: number;
  refillRatePerSecond: number;
  cost?: number;
}

export interface GrantedRateReservation {
  reserved: true;
  reservedAt: Date;
  remaining: number;
}

export interface BlockedRateReservation {
  reserved: false;
  retryAt: Date;
  retryAfterMs: number;
  consumeExecutionRetry: false;
  blockedBy: RateBucketKey[];
}

export type RateReservationResult =
  | GrantedRateReservation
  | BlockedRateReservation;

type RateBucketRow = Selectable<DB["rate_reservation_buckets"]>;

interface NormalizedRateLimit {
  key: {
    globalKey: string;
    partitionKey: string;
  };
  capacity: number;
  refillRatePerSecond: number;
  cost: number;
}

interface RateBucketState {
  limit: NormalizedRateLimit;
  available: number;
  retryAtMs: number;
}

const tracer = getTracer("@catamorphic/core");

export class RateReservationsService {
  constructor(private readonly db: Kysely<DB>) {}

  async reserve(args: {
    tenantId: string;
    limits: readonly RateLimit[];
  }): Promise<RateReservationResult> {
    const limits = normalizeLimits(args.limits);
    return withSpan(
      {
        tracer,
        name: "rate_reservations.reserve",
        attributes: {
          "catamorphic.tenant.id": args.tenantId,
          "catamorphic.rate_reservations.bucket_count": limits.length,
        },
      },
      () =>
        this.db.transaction().execute(async (trx) => {
          await createMissingBuckets({
            trx,
            tenantId: args.tenantId,
            limits,
          });
          const rows = await lockBucketRows({
            trx,
            tenantId: args.tenantId,
            limits,
          });
          // Read the clock only once the rows are locked. transaction_timestamp()
          // is fixed at BEGIN, so a caller that queued behind the lock would
          // stamp refilled_at earlier than the holder before it, and the next
          // caller would then re-credit time that had already been spent.
          const now = await databaseNow(trx);
          const states = rows.map((row, index) =>
            calculateState({
              row,
              limit: limits[index],
              now,
            }),
          );
          const blocked = states.filter(
            (state) => state.retryAtMs > now.getTime(),
          );
          await Promise.all(
            states.map((state) =>
              persistState({
                trx,
                tenantId: args.tenantId,
                state,
                now,
                consume: blocked.length === 0,
              }),
            ),
          );

          if (blocked.length === 0) {
            return {
              reserved: true,
              reservedAt: now,
              remaining: Math.min(
                ...states.map((state) => state.available - state.limit.cost),
              ),
            };
          }

          const retryAtMs = Math.max(
            ...blocked.map((state) => state.retryAtMs),
          );
          return {
            reserved: false,
            retryAt: new Date(retryAtMs),
            retryAfterMs: Math.max(1, Math.ceil(retryAtMs - now.getTime())),
            consumeExecutionRetry: false,
            blockedBy: blocked.map((state) => ({
              globalKey: state.limit.key.globalKey,
              ...(state.limit.key.partitionKey
                ? { partitionKey: state.limit.key.partitionKey }
                : {}),
            })),
          };
        }),
    );
  }

  async applyRetryAfter(args: {
    tenantId: string;
    keys: readonly RateBucketKey[];
    retryAfterMs: number;
  }): Promise<Date> {
    const keys = normalizeKeys(args.keys);
    requirePositiveFinite(args.retryAfterMs, "retryAfterMs");
    return withSpan(
      {
        tracer,
        name: "rate_reservations.apply_retry_after",
        attributes: {
          "catamorphic.tenant.id": args.tenantId,
          "catamorphic.rate_reservations.bucket_count": keys.length,
          "catamorphic.rate_reservations.retry_after_ms": args.retryAfterMs,
        },
      },
      () =>
        this.db.transaction().execute(async (trx) => {
          const result = await sql<{ now: Date; blocked_until: Date }>`
            SELECT
              transaction_timestamp() AS now,
              transaction_timestamp()
                + (${args.retryAfterMs} * interval '1 millisecond') AS blocked_until
          `.execute(trx);
          const clock = result.rows[0];
          if (!clock)
            throw new Error("Database did not return its current time");
          await updateBlockedRows({
            trx,
            tenantId: args.tenantId,
            keys,
            now: clock.now,
            blockedUntil: clock.blocked_until,
          });
          return clock.blocked_until;
        }),
    );
  }
}

function normalizeLimits(
  limits: readonly RateLimit[],
): readonly NormalizedRateLimit[] {
  if (limits.length === 0) {
    throw new Error("At least one rate limit is required");
  }
  const normalized = limits
    .map((limit) => {
      requirePositiveFinite(limit.capacity, "capacity");
      requirePositiveFinite(limit.refillRatePerSecond, "refillRatePerSecond");
      const cost = limit.cost ?? 1;
      requirePositiveFinite(cost, "cost");
      if (cost > limit.capacity) {
        throw new Error("Rate reservation cost cannot exceed capacity");
      }
      return {
        key: normalizeKey(limit.key),
        capacity: limit.capacity,
        refillRatePerSecond: limit.refillRatePerSecond,
        cost,
      };
    })
    .sort(compareLimits);
  assertUniqueKeys(normalized.map((limit) => limit.key));
  return normalized;
}

function normalizeKeys(
  keys: readonly RateBucketKey[],
): readonly NormalizedRateLimit["key"][] {
  if (keys.length === 0) {
    throw new Error("At least one rate bucket key is required");
  }
  const normalized = keys.map(normalizeKey).sort(compareKeys);
  assertUniqueKeys(normalized);
  return normalized;
}

function normalizeKey(key: RateBucketKey): NormalizedRateLimit["key"] {
  requireKeyPart(key.globalKey, "globalKey");
  if (key.partitionKey !== undefined) {
    requireKeyPart(key.partitionKey, "partitionKey");
  }
  return {
    globalKey: key.globalKey,
    partitionKey: key.partitionKey ?? "",
  };
}

function requireKeyPart(value: string, name: string): void {
  if (value.length === 0 || value.length > 500) {
    throw new Error(`${name} must contain between 1 and 500 characters`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function assertUniqueKeys(keys: readonly NormalizedRateLimit["key"][]): void {
  const unique = new Set(
    keys.map(
      (key) => `${key.globalKey.length}:${key.globalKey}${key.partitionKey}`,
    ),
  );
  if (unique.size !== keys.length) {
    throw new Error("Rate bucket keys must be unique within a reservation");
  }
}

function compareLimits(
  left: NormalizedRateLimit,
  right: NormalizedRateLimit,
): number {
  return compareKeys(left.key, right.key);
}

function compareKeys(
  left: NormalizedRateLimit["key"],
  right: NormalizedRateLimit["key"],
): number {
  return (
    left.globalKey.localeCompare(right.globalKey) ||
    left.partitionKey.localeCompare(right.partitionKey)
  );
}

async function createMissingBuckets(args: {
  trx: Transaction<DB>;
  tenantId: string;
  limits: readonly NormalizedRateLimit[];
}): Promise<void> {
  await args.trx
    .insertInto("rate_reservation_buckets")
    .values(
      args.limits.map((limit) => ({
        tenant_id: args.tenantId,
        global_key: limit.key.globalKey,
        partition_key: limit.key.partitionKey,
        capacity: limit.capacity,
        tokens: limit.capacity,
        refill_rate_per_second: limit.refillRatePerSecond,
      })),
    )
    .onConflict((conflict) =>
      conflict
        .columns(["tenant_id", "global_key", "partition_key"])
        .doNothing(),
    )
    .execute();
}

async function databaseNow(trx: Transaction<DB>): Promise<Date> {
  const result = await sql<{ now: Date }>`
    SELECT clock_timestamp() AS now
  `.execute(trx);
  const clock = result.rows[0];
  if (!clock) throw new Error("Database did not return its current time");
  return clock.now;
}

async function lockBucketRows(args: {
  trx: Transaction<DB>;
  tenantId: string;
  limits: readonly NormalizedRateLimit[];
  index?: number;
}): Promise<readonly RateBucketRow[]> {
  const index = args.index ?? 0;
  const limit = args.limits[index];
  if (!limit) return [];
  const row = await args.trx
    .selectFrom("rate_reservation_buckets")
    .where("tenant_id", "=", args.tenantId)
    .where("global_key", "=", limit.key.globalKey)
    .where("partition_key", "=", limit.key.partitionKey)
    .selectAll()
    .forUpdate()
    .executeTakeFirstOrThrow();
  const remaining = await lockBucketRows({
    ...args,
    index: index + 1,
  });
  return [row, ...remaining];
}

function calculateState(args: {
  row: RateBucketRow;
  limit: NormalizedRateLimit | undefined;
  now: Date;
}): RateBucketState {
  if (!args.limit) {
    throw new Error("Rate reservation bucket did not match its limit");
  }
  const elapsedSeconds = Math.max(
    0,
    (args.now.getTime() - args.row.refilled_at.getTime()) / 1_000,
  );
  const available = Math.min(
    args.limit.capacity,
    Number(args.row.tokens) + elapsedSeconds * args.limit.refillRatePerSecond,
  );
  const tokenDelayMs =
    available >= args.limit.cost
      ? 0
      : ((args.limit.cost - available) / args.limit.refillRatePerSecond) *
        1_000;
  const blockedUntilMs = args.row.blocked_until?.getTime() ?? 0;
  return {
    limit: args.limit,
    available,
    retryAtMs: Math.max(args.now.getTime() + tokenDelayMs, blockedUntilMs),
  };
}

async function persistState(args: {
  trx: Transaction<DB>;
  tenantId: string;
  state: RateBucketState;
  now: Date;
  consume: boolean;
}): Promise<void> {
  await args.trx
    .updateTable("rate_reservation_buckets")
    .set({
      capacity: args.state.limit.capacity,
      // Float subtraction of equal magnitudes lands just under zero
      // (-6.7e-16 when available === cost), which the tokens >= 0 check rejects.
      tokens: Math.max(
        0,
        args.state.available - (args.consume ? args.state.limit.cost : 0),
      ),
      refill_rate_per_second: args.state.limit.refillRatePerSecond,
      refilled_at: args.now,
      updated_at: args.now,
    })
    .where("tenant_id", "=", args.tenantId)
    .where("global_key", "=", args.state.limit.key.globalKey)
    .where("partition_key", "=", args.state.limit.key.partitionKey)
    .executeTakeFirstOrThrow();
}

async function updateBlockedRows(args: {
  trx: Transaction<DB>;
  tenantId: string;
  keys: readonly NormalizedRateLimit["key"][];
  now: Date;
  blockedUntil: Date;
  index?: number;
}): Promise<void> {
  const index = args.index ?? 0;
  const key = args.keys[index];
  if (!key) return;
  const result = await args.trx
    .updateTable("rate_reservation_buckets")
    .set({
      blocked_until: sql<Date>`
        GREATEST(
          COALESCE(blocked_until, '-infinity'::timestamptz),
          ${args.blockedUntil}
        )
      `,
      updated_at: args.now,
    })
    .where("tenant_id", "=", args.tenantId)
    .where("global_key", "=", key.globalKey)
    .where("partition_key", "=", key.partitionKey)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) {
    throw new Error(
      `Rate bucket '${key.globalKey}:${key.partitionKey}' does not exist`,
    );
  }
  await updateBlockedRows({
    ...args,
    index: index + 1,
  });
}
