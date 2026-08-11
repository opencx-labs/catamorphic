import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RateLimit,
  RateReservationsService,
} from "../services/rate-reservations-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_rate_reservations_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const reservations = new RateReservationsService(db);
const tenantId = crypto.randomUUID();
const otherTenantId = crypto.randomUUID();

describeIf("RateReservationsService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values([
        { id: tenantId, name: "Rate reservation test tenant" },
        { id: otherTenantId, name: "Other rate reservation tenant" },
      ])
      .execute();
  });

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("creates one deterministic bucket and enforces its limit concurrently", async () => {
    const limit: RateLimit = {
      key: {
        globalKey: "source-api:contacts",
        partitionKey: "tenant-import",
      },
      capacity: 4,
      refillRatePerSecond: 0.000_001,
    };
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        reservations.reserve({ tenantId, limits: [limit] }),
      ),
    );

    expect(results.filter((result) => result.reserved)).toHaveLength(4);
    expect(results.filter((result) => !result.reserved)).toHaveLength(20);
    await expect(
      reservations.reserve({
        tenantId: otherTenantId,
        limits: [limit],
      }),
    ).resolves.toMatchObject({ reserved: true });
    const rows = await db
      .selectFrom("rate_reservation_buckets")
      .where("tenant_id", "=", tenantId)
      .where("global_key", "=", limit.key.globalKey)
      .where("partition_key", "=", limit.key.partitionKey ?? "")
      .select(["global_key", "partition_key"])
      .execute();
    expect(rows).toEqual([
      {
        global_key: "source-api:contacts",
        partition_key: "tenant-import",
      },
    ]);
  });

  it("reserves global and partition buckets atomically", async () => {
    const globalLimit: RateLimit = {
      key: { globalKey: "provider:language-model" },
      capacity: 2,
      refillRatePerSecond: 0.000_001,
    };
    const partitionA: RateLimit = {
      key: {
        globalKey: "provider:language-model",
        partitionKey: "model:a",
      },
      capacity: 1,
      refillRatePerSecond: 0.000_001,
    };
    const partitionB: RateLimit = {
      key: {
        globalKey: "provider:language-model",
        partitionKey: "model:b",
      },
      capacity: 1,
      refillRatePerSecond: 0.000_001,
    };

    await expect(
      reservations.reserve({
        tenantId,
        limits: [globalLimit, partitionB],
      }),
    ).resolves.toMatchObject({ reserved: true });
    const blocked = await reservations.reserve({
      tenantId,
      limits: [globalLimit, partitionB],
    });
    expect(blocked).toMatchObject({
      reserved: false,
      consumeExecutionRetry: false,
      blockedBy: [
        {
          globalKey: "provider:language-model",
          partitionKey: "model:b",
        },
      ],
    });
    await expect(
      reservations.reserve({
        tenantId,
        limits: [globalLimit, partitionA],
      }),
    ).resolves.toMatchObject({ reserved: true });
  });

  it("refills capacity using database time", async () => {
    const limit: RateLimit = {
      key: { globalKey: "action:send-message" },
      capacity: 1,
      refillRatePerSecond: 2,
    };

    await expect(
      reservations.reserve({ tenantId, limits: [limit] }),
    ).resolves.toMatchObject({ reserved: true });
    const blocked = await reservations.reserve({
      tenantId,
      limits: [limit],
    });
    expect(blocked.reserved).toBe(false);
    if (blocked.reserved) {
      throw new Error("Expected the second reservation to be blocked");
    }
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    await delay({ milliseconds: 550 });

    await expect(
      reservations.reserve({ tenantId, limits: [limit] }),
    ).resolves.toMatchObject({ reserved: true });
  });

  it("honors Retry-After without consuming an execution retry", async () => {
    const limit: RateLimit = {
      key: {
        globalKey: "provider:external-api",
        partitionKey: "action:create",
      },
      capacity: 100,
      refillRatePerSecond: 100,
    };
    await reservations.reserve({ tenantId, limits: [limit] });
    const blockedUntil = await reservations.applyRetryAfter({
      tenantId,
      keys: [limit.key],
      retryAfterMs: 150,
    });
    const blocked = await reservations.reserve({
      tenantId,
      limits: [limit],
    });

    expect(blocked.reserved).toBe(false);
    if (blocked.reserved) {
      throw new Error("Expected Retry-After to block the reservation");
    }
    expect(blocked.consumeExecutionRetry).toBe(false);
    expect(blocked.retryAt.getTime()).toBe(blockedUntil.getTime());
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    await delay({ milliseconds: 175 });

    await expect(
      reservations.reserve({ tenantId, limits: [limit] }),
    ).resolves.toMatchObject({ reserved: true });
  });
});

function delay(args: { milliseconds: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, args.milliseconds));
}
