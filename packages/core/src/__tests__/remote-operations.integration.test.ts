import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RemoteExecutorLeaseLostError,
  RemoteOperationQueue,
  RemoteReceiptRefusedError,
} from "../services/remote-operations.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_remote_operations";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});

/** One executor whose lease the test holds or drops. */
function executor() {
  const lease = {
    executor: `node:${crypto.randomUUID()}`,
    leaseToken: crypto.randomUUID(),
  };
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
    queue,
    provider,
    drop: () => {
      held = false;
    },
    poll: (pollId: string) =>
      queue.poll({
        ...lease,
        pollId,
        waitMs: 5_000,
        leaseHeld: async () => held,
      }),
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
    const remote = executor();
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

  it("gives a retried poll the operation it took, and no other poll", async () => {
    const remote = executor();
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
    expect(other).toBeNull();
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
    const remote = executor();
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
    const remote = executor();
    const result = remote.provider.downloadFile("sandbox-1", "/missing");
    const job = await remote.poll(crypto.randomUUID());
    await remote.queue.complete({
      ...remote.lease,
      operationId: job?.id ?? "",
      error: "No such file",
    });
    await expect(result).rejects.toThrow("No such file");
  });
});
