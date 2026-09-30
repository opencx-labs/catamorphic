import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ReplicaClaimBusyError,
  ReplicaClaimLostError,
  renewReplicaClaim,
  takeReplicaClaim,
  withReplicaClaim,
} from "../services/replica-claims.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_claims_${crypto.randomUUID().replaceAll("-", "")}`;
// Two pools: two replicas of one deployment.
const first = createDatabase({ connectionString, schema, poolSize: 4 });
const second = createDatabase({ connectionString, schema, poolSize: 4 });
type Replica = typeof first;

describeIf("claims shared by replicas (ADR 0193)", () => {
  beforeAll(async () => {
    await migrateToLatest({ db: first, schema });
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(first);
    await first.destroy();
    await second.destroy();
  });

  it("runs one holder's work at a time across replicas", async () => {
    let inside = 0;
    let most = 0;
    const work = (db: Replica) =>
      withReplicaClaim({
        db,
        name: "create-runtime",
        waitMs: 30_000,
        pollMs: 20,
        operation: async () => {
          inside++;
          most = Math.max(most, inside);
          await new Promise((resolve) => setTimeout(resolve, 50));
          inside--;
        },
      });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        work(index % 2 === 0 ? first : second),
      ),
    );
    expect(most).toBe(1);
    expect(
      await first.selectFrom("replica_claims").selectAll().execute(),
    ).toEqual([]);
  });

  it("refuses a held claim once the wait runs out", async () => {
    let release = () => {};
    const held = withReplicaClaim({
      db: first,
      name: "publish",
      operation: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(
      withReplicaClaim({
        db: second,
        name: "publish",
        waitMs: 100,
        pollMs: 20,
        operation: async () => {},
      }),
    ).rejects.toBeInstanceOf(ReplicaClaimBusyError);
    release();
    await held;
  });

  it("stops the work once its claim is taken over", async () => {
    let seen: AbortSignal | undefined;
    const work = withReplicaClaim({
      db: first,
      name: "runtime-lapse",
      ttlSeconds: 2,
      operation: ({ signal }) => {
        seen = signal;
        return new Promise<void>(() => {});
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The claim lapsed (a frozen process) and another replica took it.
    await second
      .updateTable("replica_claims")
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where("name", "=", "runtime-lapse")
      .execute();
    expect(
      await takeReplicaClaim({
        db: second,
        name: "runtime-lapse",
        holder: "other",
        ttlSeconds: 60,
      }),
    ).toBe(true);
    await expect(work).rejects.toBeInstanceOf(ReplicaClaimLostError);
    expect(seen?.aborted).toBe(true);
    // The claim stays the new holder's.
    expect(
      await first
        .selectFrom("replica_claims")
        .select("holder")
        .where("name", "=", "runtime-lapse")
        .executeTakeFirst(),
    ).toEqual({ holder: "other" });
  });

  it("is a schedule when never released: nobody takes it before it lapses", async () => {
    const name = `sync:${crypto.randomUUID()}`;
    const take = (db: Replica, holder: string) =>
      takeReplicaClaim({ db, name, holder, ttlSeconds: 60 });
    const taken = await Promise.all([take(first, "a"), take(second, "b")]);
    expect(taken.filter(Boolean)).toHaveLength(1);
    const winner = taken[0] ? "a" : "b";
    expect(await take(first, winner)).toBe(false);
    expect(
      await renewReplicaClaim({
        db: second,
        name,
        holder: winner,
        ttlSeconds: 60,
      }),
    ).toBe(true);
    await first
      .updateTable("replica_claims")
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where("name", "=", name)
      .execute();
    expect(
      await renewReplicaClaim({
        db: second,
        name,
        holder: winner,
        ttlSeconds: 60,
      }),
    ).toBe(false);
    expect(await take(second, "c")).toBe(true);
  });
});
