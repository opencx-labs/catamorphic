import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import {
  type ClientRunnerOperation,
  ClientRunnerOperationSchema,
  forwardingSandboxProvider,
} from "./client-runners-service.js";
import { toJson } from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");

/** The worker lost its node lease; it must connect again before polling. */
export class RemoteWorkerLeaseLostError extends Error {
  constructor() {
    super("The worker's node lease is no longer held");
    this.name = "RemoteWorkerLeaseLostError";
  }
}

/**
 * The operation queue between a control-plane instance and a remote worker
 * (ADR 0164). The control plane holds the worker node's lease and runs its
 * agents' controller loops; sandbox operations travel to the worker through
 * this queue, fenced by the node's current lease token. The worker never
 * receives database or vault access. Hosts authenticate workers before
 * calling {@link poll} or {@link complete}.
 */
export class RemoteWorkerJobsService {
  constructor(private readonly db: Kysely<DB>) {}

  /** Control-plane side: forward sandbox operations to the node's worker. */
  sandboxProvider(args: {
    nodeId: string;
    leaseToken: string;
    workspaceRoot: string;
    timeoutMs?: number;
  }): SandboxProvider {
    return forwardingSandboxProvider({
      workspaceRoot: args.workspaceRoot,
      call: (operation) =>
        withSpan(
          {
            tracer,
            name: "worker.execute",
            attributes: {
              "catamorphic.worker.id": args.nodeId,
              "catamorphic.worker.operation": operation.kind,
            },
          },
          () => this.dispatch({ ...args, operation }),
        ),
    });
  }

  private async dispatch(args: {
    nodeId: string;
    leaseToken: string;
    operation: ClientRunnerOperation;
    timeoutMs?: number;
  }): Promise<unknown> {
    const timeoutMs = args.timeoutMs ?? 300_000;
    const row = await this.db
      .insertInto("worker_node_jobs")
      .values({
        node_id: args.nodeId,
        lease_token: args.leaseToken,
        operation: toJson(args.operation),
        expires_at: sql`now() + ${`${Math.ceil(timeoutMs / 1000)} seconds`}::interval`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.db
        .selectFrom("worker_node_jobs")
        .select(["status", "response", "error"])
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      if (job.status === "completed") return job.response;
      if (job.status === "failed")
        throw new Error(job.error ?? "Remote execution failed");
      if (!(await this.leaseHeld(args))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.db
      .updateTable("worker_node_jobs")
      .set({
        status: "failed",
        error: "Worker disconnected or timed out; the outcome may be unknown",
      })
      .where("id", "=", row.id)
      .where("status", "in", ["pending", "running"])
      .execute();
    throw new Error(
      "The worker disconnected or timed out. Check the last action before retrying.",
    );
  }

  /**
   * Worker side: take the next operation, waiting up to `waitMs` for one.
   * Throws once the node's lease moved on, so a stale connection stops.
   */
  async poll(args: {
    nodeId: string;
    leaseToken: string;
    waitMs?: number;
  }): Promise<{ id: string; operation: ClientRunnerOperation } | null> {
    const deadline = Date.now() + (args.waitMs ?? 0);
    for (;;) {
      if (!(await this.leaseHeld(args))) throw new RemoteWorkerLeaseLostError();
      const job = await this.db.transaction().execute(async (trx) => {
        const next = await trx
          .selectFrom("worker_node_jobs")
          .select(["id", "operation"])
          .where("node_id", "=", args.nodeId)
          .where("lease_token", "=", args.leaseToken)
          .where("status", "=", "pending")
          .where("expires_at", ">", sql<Date>`now()`)
          .orderBy("created_at")
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!next) return null;
        await trx
          .updateTable("worker_node_jobs")
          .set({ status: "running" })
          .where("id", "=", next.id)
          .execute();
        return {
          id: next.id,
          operation: ClientRunnerOperationSchema.parse(next.operation),
        };
      });
      if (job || Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Worker side: record one operation's outcome. Idempotent per receipt. */
  async complete(args: {
    nodeId: string;
    leaseToken: string;
    jobId: string;
    response?: unknown;
    error?: string;
  }): Promise<void> {
    const updated = await this.db
      .updateTable("worker_node_jobs")
      .set({
        status: args.error ? "failed" : "completed",
        response: toJson(args.response ?? null),
        error: args.error ?? null,
      })
      .where("id", "=", args.jobId)
      .where("node_id", "=", args.nodeId)
      .where("lease_token", "=", args.leaseToken)
      .where("status", "=", "running")
      .returning("id")
      .executeTakeFirst();
    if (updated) return;
    const receipt = await this.db
      .selectFrom("worker_node_jobs")
      .select("id")
      .where("id", "=", args.jobId)
      .where("node_id", "=", args.nodeId)
      .where("lease_token", "=", args.leaseToken)
      .where("status", "=", args.error ? "failed" : "completed")
      .executeTakeFirst();
    if (!receipt) {
      throw new Error(
        "Execution receipt is no longer accepted; inspect the session before retrying",
      );
    }
  }

  /** Whether this lease token still owns the node (a worker keepalive). */
  async leaseHeld(args: {
    nodeId: string;
    leaseToken: string;
  }): Promise<boolean> {
    return Boolean(
      await this.db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", args.nodeId)
        .where("lease_token", "=", args.leaseToken)
        .where("enabled", "=", true)
        .where("lease_expires_at", ">", sql<Date>`now()`)
        .executeTakeFirst(),
    );
  }
}
