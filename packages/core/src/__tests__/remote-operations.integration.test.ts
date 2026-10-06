import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPERATION_NOT_OPENED_ERROR,
  openRemoteOperation,
  RemoteExecutorLeaseLostError,
  RemoteOperationQueue,
  RemoteReceiptRefusedError,
  registerExecutorKey,
  sealRemoteOperation,
} from "../services/remote-operations.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_remote_operations";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});

/**
 * One executor whose lease the test holds or drops. Its operations are
 * sealed to its key (ADR 0207); `poll` opens what it takes.
 */
async function executor() {
  const lease = {
    executor: `node:${crypto.randomUUID()}`,
    leaseToken: crypto.randomUUID(),
  };
  const keys = generateExecutorKeyPair();
  await registerExecutorKey({ db, ...lease, publicKey: keys.publicKey });
  let held = true;
  const queue = new RemoteOperationQueue(db);
  const provider = queue.provider({
    ...lease,
    leaseHeld: async (token) => held && token === lease.leaseToken,
    label: "The worker",
    workspaceRoot: "/workspace",
    processes: false,
  });
  return {
    lease,
    keys,
    queue,
    provider,
    drop: () => {
      held = false;
    },
    poll: async (pollId: string) => {
      const [job] = await queue.poll({
        ...lease,
        pollId,
        waitMs: 5_000,
        leaseHeld: async () => held,
      });
      return job
        ? {
            id: job.id,
            operation: openRemoteOperation({
              operationId: job.id,
              executor: lease.executor,
              envelope: job.operation,
              privateKeys: [keys.privateKey],
            }),
          }
        : null;
    },
  };
}

describe("remote operation queue (ADR 0187)", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("delivers an operation and its receipt, then forgets both", async () => {
    const remote = await executor();
    const result = remote.provider.executeCommand("sandbox-1", "pwd");
    const job = await remote.poll(crypto.randomUUID());
    expect(job?.operation).toEqual({
      kind: "execute",
      sandboxId: "sandbox-1",
      command: "pwd",
    });
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      response: { exitCode: 0, result: "/workspace" },
    });
    await expect(result).resolves.toEqual({
      exitCode: 0,
      result: "/workspace",
    });
    const left = await db
      .selectFrom("remote_operations")
      .select("id")
      .where("executor", "=", remote.lease.executor)
      .execute();
    expect(left).toEqual([]);
  });

  it("stores a receipt only sealed to the waiting controller (ADR 0207)", async () => {
    // Every response written to a queued row, as Postgres stores it.
    for (const statement of [
      `CREATE TABLE ${schema}.receipts_seen (response text)`,
      `CREATE FUNCTION ${schema}.receipt_seen() RETURNS trigger AS $$
       BEGIN
         INSERT INTO ${schema}.receipts_seen VALUES (NEW.response::text);
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
      `CREATE TRIGGER receipt_seen AFTER UPDATE OF response
         ON ${schema}.remote_operations FOR EACH ROW
         WHEN (NEW.response IS NOT NULL)
         EXECUTE FUNCTION ${schema}.receipt_seen()`,
    ])
      await sql.raw(statement).execute(db);
    const remote = await executor();
    const output = "STRIPE_KEY=sk_live_terminal_output";
    const result = remote.provider.executeCommand("sandbox-1", "env");
    const job = await remote.poll(crypto.randomUUID());
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      response: { exitCode: 0, result: output },
    });
    await expect(result).resolves.toEqual({ exitCode: 0, result: output });
    const seen = await sql<{ response: string }>`
      SELECT response FROM ${sql.raw(schema)}.receipts_seen
    `.execute(db);
    expect(seen.rows.length).toBeGreaterThan(0);
    for (const row of seen.rows) {
      expect(row.response).not.toContain("sk_live_terminal_output");
      expect(JSON.parse(row.response)).toMatchObject({
        sealed: { v: 1 },
      });
    }
    await sql
      .raw(`DROP TRIGGER receipt_seen ON ${schema}.remote_operations`)
      .execute(db);
  });

  it("resets a pooled machine through its executor, and only while it is connected (ADR 0205)", async () => {
    const remote = await executor();
    const reset = (connected: boolean) =>
      remote.queue.resetMachine({
        executor: remote.lease.executor,
        leaseToken: async () =>
          connected ? remote.lease.leaseToken : undefined,
        leaseHeld: async (token) => token === remote.lease.leaseToken,
        label: "Worker office-1",
      });
    await expect(reset(false)).rejects.toThrow(
      "Worker office-1 is not connected right now",
    );
    const done = reset(true);
    const job = await remote.poll(crypto.randomUUID());
    expect(job?.operation).toEqual({ kind: "machine.reset" });
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      response: null,
    });
    await expect(done).resolves.toBeUndefined();
  });

  it("stops waiting for a reset at the caller's bound, and refuses its late receipt", async () => {
    const remote = await executor();
    const started = Date.now();
    const waiting = remote.queue.resetMachine({
      executor: remote.lease.executor,
      leaseToken: async () => remote.lease.leaseToken,
      leaseHeld: async (token) => token === remote.lease.leaseToken,
      label: "Worker office-1",
      timeoutMs: 300,
    });
    // The executor takes it but is slow to answer.
    const job = await remote.poll(crypto.randomUUID());
    await expect(waiting).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(30_000);
    await expect(
      remote.queue.complete({
        ...remote.lease,
        operationId: job?.id ?? "",
        response: null,
      }),
    ).rejects.toBeInstanceOf(RemoteReceiptRefusedError);
  });

  it("gives a retried poll the operation it took, and no other poll", async () => {
    const remote = await executor();
    const result = remote.provider.executeCommand("sandbox-1", "echo once");
    const pollId = crypto.randomUUID();
    const taken = await remote.poll(pollId);
    // The response was lost: the executor asks again with the same id.
    const again = await remote.poll(pollId);
    expect(again).toEqual(taken);
    // Another poll does not see an operation already taken.
    const other = await remote.queue.poll({
      ...remote.lease,
      pollId: crypto.randomUUID(),
      waitMs: 0,
      leaseHeld: async () => true,
    });
    expect(other).toEqual([]);
    const receipt = {
      ...remote.lease,
      operationId: taken?.id ?? "",
      response: { exitCode: 0, result: "once" },
    };
    await remote.queue.complete(receipt);
    // A receipt retried after its response was lost still succeeds while
    // the controller has not yet read it, or is refused once it has.
    await remote.queue.complete(receipt).catch((error: unknown) => {
      expect(error).toBeInstanceOf(RemoteReceiptRefusedError);
    });
    await expect(result).resolves.toEqual({ exitCode: 0, result: "once" });
    await expect(remote.queue.complete(receipt)).rejects.toBeInstanceOf(
      RemoteReceiptRefusedError,
    );
  });

  it("fails an operation whose executor lost its lease, and refuses its late receipt", async () => {
    const remote = await executor();
    const result = remote.provider.executeCommand("sandbox-1", "sleep 60");
    const job = await remote.poll(crypto.randomUUID());
    remote.drop();
    await expect(result).rejects.toThrow(/outcome may be unknown/);
    await expect(
      remote.queue.complete({
        ...remote.lease,
        operationId: job?.id ?? "",
        response: { exitCode: 0, result: "" },
      }),
    ).rejects.toBeInstanceOf(RemoteReceiptRefusedError);
    await expect(remote.poll(crypto.randomUUID())).rejects.toBeInstanceOf(
      RemoteExecutorLeaseLostError,
    );
  });

  it("records a failed operation's error", async () => {
    const remote = await executor();
    const result = remote.provider.downloadFile("sandbox-1", "/missing");
    const job = await remote.poll(crypto.randomUUID());
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      error: "No such file",
    });
    await expect(result).rejects.toThrow("No such file");
  });

  it("takes several operations in one poll, and a retry takes no more", async () => {
    const remote = await executor();
    const results = ["one", "two", "three"].map((word) =>
      remote.provider.executeCommand("sandbox-1", `echo ${word}`),
    );
    const pollId = crypto.randomUUID();
    const take = (max: number) =>
      remote.queue.poll({
        ...remote.lease,
        pollId,
        max,
        waitMs: 5_000,
        leaseHeld: async () => true,
      });
    // The three dispatches insert on their own; wait until all are queued.
    await expect
      .poll(
        async () =>
          (
            await db
              .selectFrom("remote_operations")
              .select("id")
              .where("executor", "=", remote.lease.executor)
              .execute()
          ).length,
      )
      .toBe(3);
    const taken = await take(2);
    expect(taken).toHaveLength(2);
    // The answer was lost; the retry asks for more but gets the same two.
    expect(await take(3)).toEqual(taken);
    for (const job of taken)
      await remote.queue.complete({
        ...remote.lease,
        operationId: job.id,
        response: { exitCode: 0, result: "" },
      });
    const rest = await remote.queue.poll({
      ...remote.lease,
      pollId: crypto.randomUUID(),
      max: 5,
      waitMs: 5_000,
      leaseHeld: async () => true,
    });
    expect(rest).toHaveLength(1);
    await remote.queue.complete({
      ...remote.lease,
      operationId: rest[0]?.id ?? "",
      response: { exitCode: 0, result: "" },
    });
    await Promise.all(results);
  });

  it("answers a retried poll whose operation was abandoned with nothing", async () => {
    const remote = await executor();
    const pollId = crypto.randomUUID();
    const operation = (command: string) => {
      const id = crypto.randomUUID();
      return {
        id,
        operation: JSON.stringify(
          sealRemoteOperation({
            operationId: id,
            executor: remote.lease.executor,
            operation: { kind: "execute", sandboxId: "sandbox-1", command },
            publicKey: remote.keys.publicKey,
          }),
        ),
      };
    };
    // The poll's operation was abandoned by a controller that stopped before
    // it could delete the row; another operation waits.
    const row = {
      executor: remote.lease.executor,
      lease_token: remote.lease.leaseToken,
      reply_key: generateExecutorKeyPair().publicKey,
      expires_at: new Date(Date.now() + 60_000),
    };
    await db
      .insertInto("remote_operations")
      .values([
        {
          ...row,
          poll_id: pollId,
          status: "failed",
          ...operation("sleep 60"),
        },
        { ...row, ...operation("echo next") },
      ])
      .execute();
    expect(
      await remote.queue.poll({
        ...remote.lease,
        pollId,
        waitMs: 0,
        leaseHeld: async () => true,
      }),
    ).toEqual([]);
    const fresh = await remote.poll(crypto.randomUUID());
    expect(fresh?.operation).toMatchObject({ command: "echo next" });
  });

  it("takes nothing for a poll whose executor hung up", async () => {
    const remote = await executor();
    const result = remote.provider.executeCommand("sandbox-1", "echo later");
    const hungUp = new AbortController();
    hungUp.abort();
    expect(
      await remote.queue.poll({
        ...remote.lease,
        pollId: crypto.randomUUID(),
        waitMs: 5_000,
        signal: hungUp.signal,
        leaseHeld: async () => true,
      }),
    ).toEqual([]);
    const job = await remote.poll(crypto.randomUUID());
    expect(job?.operation).toMatchObject({ command: "echo later" });
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      response: { exitCode: 0, result: "later" },
    });
    await expect(result).resolves.toEqual({ exitCode: 0, result: "later" });
  });

  it("seals again an operation its executor could not open after rotating its key (ADR 0207)", async () => {
    const remote = await executor();
    const result = remote.provider.executeCommand("sandbox-1", "echo resealed");
    const take = () =>
      remote.queue.poll({
        ...remote.lease,
        pollId: crypto.randomUUID(),
        waitMs: 5_000,
        leaseHeld: async () => true,
      });
    const [stale] = await take();
    if (!stale) throw new Error("No operation");
    // The executor rotated twice and no longer holds the key this one was
    // sealed to: it did not run, and says so.
    const rotated = generateExecutorKeyPair();
    await registerExecutorKey({
      db,
      executor: remote.lease.executor,
      publicKey: rotated.publicKey,
    });
    const open = (job: { id: string; operation: unknown }) =>
      openRemoteOperation({
        operationId: job.id,
        executor: remote.lease.executor,
        envelope: job.operation,
        privateKeys: [rotated.privateKey],
      });
    expect(() => open(stale)).toThrow();
    await remote.queue.complete({
      ...remote.lease,
      operationId: stale.id,
      error: OPERATION_NOT_OPENED_ERROR,
    });
    // Its controller seals it again, to the key the executor holds now.
    const [again] = await take();
    if (!again) throw new Error("The operation was not sealed again");
    expect(again.id).not.toBe(stale.id);
    expect(open(again)).toMatchObject({ command: "echo resealed" });
    await remote.queue.complete({
      ...remote.lease,
      operationId: again.id,
      response: { exitCode: 0, result: "resealed" },
    });
    await expect(result).resolves.toEqual({ exitCode: 0, result: "resealed" });
  });

  it("stores a receipt's error without any URL's credentials (ADR 0207)", async () => {
    const remote = await executor();
    const result = remote.provider.gitClone(
      "sandbox-1",
      "https://github.com/acme/app.git",
      "/workspace/app",
      { username: "x-access-token", password: "ghs_secret" },
    );
    const job = await remote.poll(crypto.randomUUID());
    const error =
      "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/acme/app.git/'";
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      error,
    });
    const stored = await db
      .selectFrom("remote_operations")
      .select("error")
      .where("id", "=", job?.id ?? "")
      .executeTakeFirst();
    // Its controller may already have deleted the row.
    if (stored) expect(stored.error).not.toContain("ghs_secret");
    const failure = await result.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("[redacted]@github.com");
    expect(String(failure)).not.toContain("ghs_secret");
    // The same receipt retried is still recognized as recorded, or refused
    // once its controller has read it.
    await remote.queue
      .complete({ ...remote.lease, operationId: job?.id ?? "", error })
      .catch((refused: unknown) =>
        expect(refused).toBeInstanceOf(RemoteReceiptRefusedError),
      );
  });
});
