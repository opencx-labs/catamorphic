import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import {
  generateExecutorKeyPair,
  SealedOperationOpenError,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ExecutorKeyMissingError,
  OperationWakeups,
  openRemoteOperation,
  RemoteOperationQueue,
  registerExecutorKey,
} from "../services/remote-operations.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_sealed_${randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });

/** A remote executor with its own key, and a controller's provider for it. */
async function executor(
  args: {
    /** The controller's replica. */
    controllerWakeups?: OperationWakeups;
    /** The replica serving the executor's polls. */
    executorWakeups?: OperationWakeups;
  } = {},
) {
  const lease = {
    executor: `node:worker.${randomUUID()}`,
    leaseToken: randomUUID(),
  };
  const keys = generateExecutorKeyPair();
  await registerExecutorKey({ db, ...lease, publicKey: keys.publicKey });
  const controller = new RemoteOperationQueue(db, {
    ...(args.controllerWakeups ? { wakeups: args.controllerWakeups } : {}),
  });
  const queue = new RemoteOperationQueue(db, {
    ...(args.executorWakeups ? { wakeups: args.executorWakeups } : {}),
  });
  return {
    lease,
    keys,
    queue,
    provider: controller.provider({
      ...lease,
      leaseHeld: async () => true,
      label: "The worker",
      workspaceRoot: "/workspace",
      processes: false,
    }),
    take: (max = 1) =>
      queue.poll({
        ...lease,
        pollId: randomUUID(),
        max,
        waitMs: 10_000,
        leaseHeld: async () => true,
      }),
    open: (
      job: { id: string; operation: unknown },
      privateKeys: readonly string[] = [keys.privateKey],
    ) =>
      openRemoteOperation({
        operationId: job.id,
        executor: lease.executor,
        envelope: job.operation,
        privateKeys,
      }),
  };
}

/** Rows queued for an executor, as Postgres stores them. */
async function stored(executorId: string) {
  return db
    .selectFrom("remote_operations")
    .select([
      "id",
      sql<string>`operation::text`.as("text"),
      sql<string>`operation->>'kind'`.as("kind"),
    ])
    .where("executor", "=", executorId)
    .orderBy("created_at")
    .execute();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describeIf("operations sealed to their executor (ADR 0206)", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("keeps only ciphertext in Postgres, and the executor still runs it", async () => {
    const remote = await executor();
    const secret = "STRIPE_KEY=sk_test_51NotARealKeyButSecret";
    const command = "curl -H 'Authorization: Bearer tok_command_secret' x";
    const uploaded = remote.provider.uploadFiles(
      "sandbox-1",
      { ".env": secret },
      "/workspace/app",
    );
    const executed = remote.provider.executeCommand("sandbox-1", command);
    await expect
      .poll(async () => (await stored(remote.lease.executor)).length)
      .toBe(2);
    const rows = await stored(remote.lease.executor);
    expect(rows.map((row) => row.kind).sort()).toEqual(["execute", "upload"]);
    for (const row of rows)
      for (const plaintext of [
        secret,
        "sk_test_51NotARealKeyButSecret",
        "tok_command_secret",
        "curl",
        ".env",
        "/workspace/app",
        "sandbox-1",
      ])
        expect(row.text).not.toContain(plaintext);

    const jobs = await remote.take(2);
    expect(jobs).toHaveLength(2);
    const opened = jobs.map((job) => ({ id: job.id, ...remote.open(job) }));
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "upload",
          files: { ".env": secret },
          basePath: "/workspace/app",
        }),
        expect.objectContaining({ kind: "execute", command }),
      ]),
    );
    for (const job of opened)
      await remote.queue.complete({
        ...remote.lease,
        operationId: job.id,
        response:
          job.kind === "execute" ? { exitCode: 0, result: "ran" } : null,
      });
    await expect(uploaded).resolves.toBeUndefined();
    await expect(executed).resolves.toEqual({ exitCode: 0, result: "ran" });
  });

  it("drops the sealed payload once the operation ran", async () => {
    const remote = await executor({
      controllerWakeups: new OperationWakeups(),
    });
    const result = remote.provider.executeCommand("sandbox-1", "echo done");
    const [job] = await remote.take();
    if (!job) throw new Error("No operation");
    // The receipt is recorded; the controller has not read it yet.
    await remote.queue.complete({
      ...remote.lease,
      operationId: job.id,
      response: { exitCode: 0, result: "done" },
    });
    const settled = await db
      .selectFrom("remote_operations")
      .select("operation")
      .where("id", "=", job.id)
      .executeTakeFirst();
    // Its controller may already have deleted the row.
    if (settled) expect(settled.operation).toEqual({ kind: "execute" });
    await expect(result).resolves.toEqual({ exitCode: 0, result: "done" });
  });

  it("seals to the key current when the operation is queued", async () => {
    const remote = await executor();
    const before = remote.provider.executeCommand("sandbox-1", "echo before");
    await expect
      .poll(async () => (await stored(remote.lease.executor)).length)
      .toBe(1);
    // The executor rotates its key while an operation waits.
    const rotated = generateExecutorKeyPair();
    await registerExecutorKey({
      db,
      executor: remote.lease.executor,
      publicKey: rotated.publicKey,
    });
    const after = remote.provider.executeCommand("sandbox-1", "echo after");
    await expect
      .poll(async () => (await stored(remote.lease.executor)).length)
      .toBe(2);
    const jobs = await remote.take(2);
    const [first, second] = jobs;
    if (!first || !second) throw new Error("Both operations were queued");
    // Only the new key: the operation sealed before the rotation is shut.
    expect(() => remote.open(first, [rotated.privateKey])).toThrow(
      SealedOperationOpenError,
    );
    // An executor keeps its previous key for what was queued before.
    const both = [rotated.privateKey, remote.keys.privateKey];
    expect(remote.open(first, both)).toMatchObject({ command: "echo before" });
    expect(remote.open(second, both)).toMatchObject({ command: "echo after" });
    for (const job of jobs)
      await remote.queue.complete({
        ...remote.lease,
        operationId: job.id,
        response: { exitCode: 0, result: "" },
      });
    await Promise.all([before, after]);
  });

  it("binds each operation to its row, its executor and its kind", async () => {
    const remote = await executor();
    const result = remote.provider.executeCommand("sandbox-1", "echo bound");
    const [job] = await remote.take();
    if (!job) throw new Error("No operation");
    expect(remote.open(job)).toMatchObject({ command: "echo bound" });
    const open = (args: {
      operationId?: string;
      executor?: string;
      kind?: string;
    }) =>
      openRemoteOperation({
        operationId: args.operationId ?? job.id,
        executor: args.executor ?? remote.lease.executor,
        envelope: { ...job.operation, kind: args.kind ?? job.operation.kind },
        privateKeys: [remote.keys.privateKey],
      });
    expect(() => open({ operationId: randomUUID() })).toThrow(
      SealedOperationOpenError,
    );
    expect(() => open({ executor: "client:someone-else" })).toThrow(
      SealedOperationOpenError,
    );
    expect(() => open({ kind: "status" })).toThrow(SealedOperationOpenError);
    await remote.queue.complete({
      ...remote.lease,
      operationId: job.id,
      response: { exitCode: 0, result: "bound" },
    });
    await result;
  });

  it("queues nothing for an executor with no key", async () => {
    const queue = new RemoteOperationQueue(db);
    const provider = queue.provider({
      executor: `node:worker.${randomUUID()}`,
      leaseToken: randomUUID(),
      leaseHeld: async () => true,
      label: "The worker",
      workspaceRoot: "/workspace",
      processes: false,
    });
    await expect(
      provider.executeCommand("sandbox-1", "echo nowhere"),
    ).rejects.toBeInstanceOf(ExecutorKeyMissingError);
  });

  /**
   * One trivial operation, from the controller queueing it to the
   * controller holding its result, with an executor already waiting.
   */
  async function roundTrip(args: {
    remote: Awaited<ReturnType<typeof executor>>;
    executorWakeups: OperationWakeups;
  }): Promise<number> {
    const subscribed = vi.mocked(args.executorWakeups.forWork).mock.calls
      .length;
    const polling = args.remote.take();
    // The executor's poll is waiting before the operation is queued, at any
    // point of its polling interval.
    await expect
      .poll(
        () =>
          vi.mocked(args.executorWakeups.forWork).mock.calls.length >
          subscribed,
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 250));
    const started = performance.now();
    const status = args.remote.provider.getSandboxStatus("sandbox-1");
    const [job] = await polling;
    if (!job) throw new Error("The poll took nothing");
    expect(args.remote.open(job)).toEqual({
      kind: "status",
      sandboxId: "sandbox-1",
    });
    await args.remote.queue.complete({
      ...args.remote.lease,
      operationId: job.id,
      response: "started",
    });
    await expect(status).resolves.toBe("started");
    return performance.now() - started;
  }

  /** Spies on a replica's wakeups; each records how many waiters woke. */
  function observed(): OperationWakeups {
    const wakeups = new OperationWakeups();
    vi.spyOn(wakeups, "forWork");
    vi.spyOn(wakeups, "workQueued");
    vi.spyOn(wakeups, "receiptRecorded");
    return wakeups;
  }
  const woken = (method: (key: string) => number) =>
    vi.mocked(method).mock.results.map((result) => result.value);

  it("wakes the replica's own waiting poll and controller at once", async () => {
    const replica = observed();
    const remote = await executor({
      controllerWakeups: replica,
      executorWakeups: replica,
    });
    const times: number[] = [];
    for (let trip = 0; trip < 15; trip++)
      times.push(await roundTrip({ remote, executorWakeups: replica }));
    // Every operation woke the executor's poll, and every receipt the
    // controller: neither waited for its polling interval.
    expect(woken(replica.workQueued)).toHaveLength(15);
    expect(woken(replica.workQueued).every((count) => count >= 1)).toBe(true);
    expect(woken(replica.receiptRecorded)).toHaveLength(15);
    expect(woken(replica.receiptRecorded).every((count) => count >= 1)).toBe(
      true,
    );
    console.info(
      `[ADR 0206] one replica, local wakeups: median round trip ${median(times).toFixed(1)} ms (${times.map((time) => time.toFixed(1)).join(", ")})`,
    );
  }, 60_000);

  it("finds operations queued on another replica by polling", async () => {
    // The controller runs on one replica, the executor's polls on another:
    // no wakeup reaches across, and every operation still completes.
    const controllerReplica = observed();
    const executorReplica = observed();
    const remote = await executor({
      controllerWakeups: controllerReplica,
      executorWakeups: executorReplica,
    });
    const times: number[] = [];
    for (let trip = 0; trip < 15; trip++)
      times.push(await roundTrip({ remote, executorWakeups: executorReplica }));
    expect(woken(controllerReplica.workQueued)).toEqual(Array(15).fill(0));
    expect(woken(executorReplica.receiptRecorded)).toEqual(Array(15).fill(0));
    console.info(
      `[ADR 0206] two replicas, polling only (as before local wakeups): median round trip ${median(times).toFixed(1)} ms (${times.map((time) => time.toFixed(1)).join(", ")})`,
    );
  }, 60_000);
});
