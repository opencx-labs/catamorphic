import type { DB } from "@catamorphic/db";
import { getTracer, type SpanAttributes, withSpan } from "@catamorphic/otel";
import {
  PROCESS_SIGNALS,
  type SandboxProcessProvider,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";
import {
  jsonColumn,
  storableJson,
  toJson,
  withoutNul,
} from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");

const stringMap = z.record(z.string(), z.string());
export const RemoteOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    options: z.object({
      resources: z
        .object({
          cpuMillis: z.number().int().positive().optional(),
          memoryMb: z.number().int().positive().optional(),
          storageMb: z.number().int().positive().optional(),
          gpu: z.boolean().optional(),
        })
        .optional(),
      snapshotName: z.string().optional(),
      image: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("oci"), reference: z.string() }),
          z.object({
            kind: z.literal("dockerfile"),
            path: z.string(),
            content: z.string().max(64 * 1024),
            digest: z.string(),
          }),
        ])
        .optional(),
      containers: z.boolean().optional(),
      egress: z
        .discriminatedUnion("mode", [
          z.object({ mode: z.literal("open") }),
          z.object({
            mode: z.literal("allowlist"),
            allow: z.array(z.string()).readonly(),
          }),
        ])
        .optional(),
      language: z.string().optional(),
      envVars: stringMap.optional(),
      autoStopInterval: z.number().optional(),
      labels: stringMap.optional(),
      // Members' sign-ins the executor mounts from its own disk (ADR 0197).
      signIns: z
        .array(
          z.object({
            harness: z.enum(["claude-code", "codex"]),
            member: z.string().min(1),
          }),
        )
        .readonly()
        .optional(),
    }),
  }),
  z.object({
    kind: z.enum(["start", "stop", "destroy", "status"]),
    sandboxId: z.string(),
  }),
  z.object({
    kind: z.literal("execute"),
    sandboxId: z.string(),
    command: z.string(),
    options: z
      .object({
        cwd: z.string().optional(),
        timeout: z.number().optional(),
        env: stringMap.optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("upload"),
    sandboxId: z.string(),
    files: stringMap,
    basePath: z.string(),
  }),
  z.object({
    kind: z.literal("download"),
    sandboxId: z.string(),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("clone"),
    sandboxId: z.string(),
    url: z.string(),
    path: z.string(),
    options: z
      .object({
        branch: z.string().optional(),
        commitId: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("checkout"),
    sandboxId: z.string(),
    path: z.string(),
    ref: z.string(),
  }),
  // Background processes (ADR 0174): short request/response operations; a
  // follower reads again from the cursor the last read returned.
  z.object({
    kind: z.literal("process.start"),
    sandboxId: z.string(),
    command: z.string(),
    cwd: z.string().optional(),
    env: stringMap.optional(),
    name: z.string().optional(),
    stdin: z.boolean().optional(),
  }),
  // A stdio harness in the sandbox (ADR 0180): input arrives in writes.
  z.object({
    kind: z.literal("process.write"),
    sandboxId: z.string(),
    processId: z.string(),
    data: z.string(),
    end: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("process.read"),
    sandboxId: z.string(),
    processId: z.string(),
    cursor: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
    waitMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("process.signal"),
    sandboxId: z.string(),
    processId: z.string(),
    signal: z.enum(PROCESS_SIGNALS),
  }),
  z.object({
    kind: z.literal("process.list"),
    sandboxId: z.string(),
  }),
]);
export type RemoteOperation = z.infer<typeof RemoteOperationSchema>;
const statusSchema = z.enum([
  "creating",
  "started",
  "stopped",
  "archived",
  "error",
]);
const handleSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  sandboxType: z.enum(["dev", "execution"]),
  status: statusSchema,
});

const processSchema = z.object({
  processId: z.string(),
  sandboxId: z.string(),
  command: z.string(),
  name: z.string().optional(),
  cwd: z.string(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().nullable(),
  signal: z.enum(PROCESS_SIGNALS).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  outputBytes: z.number(),
});
const processOutputSchema = z.object({
  processId: z.string(),
  chunk: z.string(),
  cursor: z.number(),
  nextCursor: z.number(),
  more: z.boolean(),
  outputBytes: z.number(),
  status: z.enum(["running", "exited"]),
  exitCode: z.number().nullable(),
  signal: z.enum(PROCESS_SIGNALS).nullable(),
});

export const RemoteOperationResultSchema = z.union([
  z.null(),
  z.string(),
  handleSchema,
  z.object({ exitCode: z.number(), result: z.string() }),
  processSchema,
  processOutputSchema,
  z.array(processSchema),
]);

/**
 * A sandbox provider whose every operation is executed elsewhere: by a
 * member's desktop runner or by a remote worker (ADR 0164). `call` delivers
 * one operation and resolves with the runner's response. `processes` says
 * whether the remote provider runs background processes (ADR 0174).
 */
function forwardingSandboxProvider(args: {
  workspaceRoot: string;
  processes: boolean;
  call: (operation: RemoteOperation) => Promise<unknown>;
}): SandboxProvider {
  const { call } = args;
  const processes: SandboxProcessProvider = {
    startProcess: async (options) =>
      processSchema.parse(await call({ kind: "process.start", ...options })),
    readProcessOutput: async (options) =>
      processOutputSchema.parse(
        await call({ kind: "process.read", ...options }),
      ),
    signalProcess: async (options) =>
      processSchema.parse(await call({ kind: "process.signal", ...options })),
    listProcesses: async (options) =>
      z
        .array(processSchema)
        .parse(await call({ kind: "process.list", ...options })),
    writeProcessInput: async (options) => {
      await call({ kind: "process.write", ...options });
    },
  };
  return {
    workspaceRoot: args.workspaceRoot,
    ...(args.processes ? { processes } : {}),
    createSandbox: async (options) =>
      handleSchema.parse(await call({ kind: "create", options })),
    startSandbox: async (sandboxId) => {
      await call({ kind: "start", sandboxId });
    },
    stopSandbox: async (sandboxId) => {
      await call({ kind: "stop", sandboxId });
    },
    destroySandbox: async (sandboxId) => {
      await call({ kind: "destroy", sandboxId });
    },
    getSandboxStatus: async (sandboxId) =>
      statusSchema.parse(await call({ kind: "status", sandboxId })),
    executeCommand: async (sandboxId, command, options) =>
      z
        .object({ exitCode: z.number(), result: z.string() })
        .parse(await call({ kind: "execute", sandboxId, command, options })),
    uploadFiles: async (sandboxId, files, basePath) => {
      await call({ kind: "upload", sandboxId, files, basePath });
    },
    downloadFile: async (sandboxId, path) =>
      z.string().parse(await call({ kind: "download", sandboxId, path })),
    gitClone: async (sandboxId, url, path, options) => {
      await call({ kind: "clone", sandboxId, url, path, options });
    },
    gitCheckout: async (sandboxId, path, ref) => {
      await call({ kind: "checkout", sandboxId, path, ref });
    },
  };
}

/** The executor no longer holds this lease; it must connect again. */
export class RemoteExecutorLeaseLostError extends Error {
  constructor() {
    super("This executor's lease moved on; connect again");
    this.name = "RemoteExecutorLeaseLostError";
  }
}

/**
 * The operation settled or was abandoned before this receipt arrived: its
 * controller no longer waits for it, so the receipt is not recorded.
 */
export class RemoteReceiptRefusedError extends Error {
  constructor() {
    super(
      "Execution receipt is no longer accepted; inspect the session before retrying",
    );
    this.name = "RemoteReceiptRefusedError";
  }
}

/** An enrolled worker node's address in the queue (ADR 0164). */
export function nodeExecutor(nodeId: string): string {
  return `node:${nodeId}`;
}

/** The error a controller sees for an operation its executor restarted under. */
export const EXECUTOR_RESTARTED_ERROR =
  "The machine restarted while this ran; the outcome is unknown. Check the last action before retrying.";

/** A remote executor and the lease that fences what it receives. */
export interface RemoteExecutorLease {
  /** `node:<id>` for an enrolled worker, `client:<id>` for a member runner. */
  executor: string;
  leaseToken: string;
}

/** How long a controller waits for one operation's receipt. */
function operationTimeoutMs(operation: RemoteOperation): number {
  // A first sandbox from a Dockerfile builds its image on the executor,
  // which may take up to the builder's 30 minutes.
  if (
    operation.kind === "create" &&
    operation.options.image?.kind === "dockerfile"
  )
    return 35 * 60_000;
  // A command's own timeout plus a margin, never less than five minutes.
  const commandSeconds =
    operation.kind === "execute" ? (operation.options?.timeout ?? 0) : 0;
  return Math.max(5 * 60_000, (commandSeconds + 60) * 1000);
}

const LEASE_CHECK_MS = 1_000;
const SWEEP_EVERY_MS = 60_000;

/**
 * The one queue between controllers and remote executors (ADR 0187): enrolled
 * workers (ADR 0164) and members' This machine runners (ADR 0098). A
 * controller enqueues a sandbox operation and waits for its receipt; the
 * executor long-polls from any control-plane instance, runs it, and posts the
 * receipt to any instance. Everything lives in Postgres, fenced by the
 * executor's lease token, so no instance keeps per-operation state.
 *
 * Delivery survives a lost response: a poll carries an id the executor keeps
 * across retries, and a retried poll receives the operation it already took.
 * An operation's payload stays only until it settles; its controller deletes
 * the row once it has the receipt. Operations whose outcome is uncertain are
 * never run twice: an abandoned one fails, and its late receipt is refused.
 */
export class RemoteOperationQueue {
  private lastSweep = 0;

  constructor(private readonly db: Kysely<DB>) {}

  /**
   * A sandbox provider whose operations run on the executor. A function
   * lease is read at each call: a worker may restart under a new epoch while
   * sessions keep this provider (ADR 0192).
   */
  provider(args: {
    executor: string;
    leaseToken: string | (() => Promise<string | undefined>);
    /** Whether the executor still holds this lease. */
    leaseHeld: (leaseToken: string) => Promise<boolean>;
    /** Names the executor in errors: "The worker", "This machine". */
    label: string;
    workspaceRoot: string;
    /** The executor's provider runs background processes (ADR 0174). */
    processes: boolean;
    attributes?: SpanAttributes;
  }): SandboxProvider {
    return forwardingSandboxProvider({
      workspaceRoot: args.workspaceRoot,
      processes: args.processes,
      call: (operation) =>
        withSpan(
          {
            tracer,
            name: "remote.execute",
            attributes: {
              ...args.attributes,
              "catamorphic.executor": args.executor,
              "catamorphic.executor.operation": operation.kind,
            },
          },
          async () => {
            const leaseToken =
              typeof args.leaseToken === "function"
                ? await args.leaseToken()
                : args.leaseToken;
            if (!leaseToken)
              throw new Error(`${args.label} is not connected right now`);
            return this.dispatch({
              executor: args.executor,
              leaseToken,
              operation,
              leaseHeld: args.leaseHeld,
              label: args.label,
            });
          },
        ),
    });
  }

  private async dispatch(args: {
    executor: string;
    leaseToken: string;
    operation: RemoteOperation;
    leaseHeld: (leaseToken: string) => Promise<boolean>;
    label: string;
  }): Promise<unknown> {
    const timeoutMs = operationTimeoutMs(args.operation);
    const row = await this.db
      .insertInto("remote_operations")
      .values({
        executor: args.executor,
        lease_token: args.leaseToken,
        operation: toJson(args.operation),
        expires_at: sql`now() + make_interval(secs => ${Math.ceil(timeoutMs / 1000)})`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    try {
      const deadline = Date.now() + timeoutMs;
      let leaseCheckedAt = Date.now();
      while (Date.now() < deadline) {
        const job = await this.db
          .selectFrom("remote_operations")
          .select(["status", "response", "error"])
          .where("id", "=", row.id)
          .executeTakeFirstOrThrow();
        if (job.status === "completed") return job.response;
        if (job.status === "failed")
          throw new Error(job.error ?? "Remote execution failed");
        if (Date.now() - leaseCheckedAt >= LEASE_CHECK_MS) {
          leaseCheckedAt = Date.now();
          if (!(await args.leaseHeld(args.leaseToken))) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Abandoned: a late receipt is refused rather than recorded.
      await this.db
        .updateTable("remote_operations")
        .set({ status: "failed" })
        .where("id", "=", row.id)
        .where("status", "in", ["pending", "running"])
        .execute();
      throw new Error(
        `${args.label} disconnected or timed out; the outcome may be unknown. Check the last action before retrying.`,
      );
    } finally {
      // Cleanup never turns a recorded outcome into a failure: a row left
      // behind is swept after it expires.
      await this.db
        .deleteFrom("remote_operations")
        .where("id", "=", row.id)
        .execute()
        .catch(() => {});
      this.sweepSoon();
    }
  }

  /**
   * Executor side: take up to `max` operations, waiting up to `waitMs` for
   * one. A poll retried with the same `pollId` receives what that poll took
   * and takes nothing more, so an answer lost on the way is never an
   * operation lost. Once `signal` aborts (the executor hung up), the poll
   * stops and gives back what it took. Throws
   * {@link RemoteExecutorLeaseLostError} once the lease moved on.
   */
  async poll(
    args: RemoteExecutorLease & {
      pollId: string;
      max?: number;
      waitMs?: number;
      signal?: AbortSignal;
      leaseHeld: () => Promise<boolean>;
    },
  ): Promise<Array<{ id: string; operation: RemoteOperation }>> {
    const deadline = Date.now() + (args.waitMs ?? 0);
    const max = Math.max(1, args.max ?? 1);
    let leaseCheckedAt = 0;
    this.sweepSoon();
    for (;;) {
      if (args.signal?.aborted) return [];
      if (Date.now() - leaseCheckedAt >= LEASE_CHECK_MS) {
        leaseCheckedAt = Date.now();
        if (!(await args.leaseHeld())) throw new RemoteExecutorLeaseLostError();
      }
      const jobs = await this.db.transaction().execute(async (trx) => {
        // One poll id at a time: a retry and the poll it retries (still
        // waiting on another instance) never both take operations.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${args.pollId}))`.execute(
          trx,
        );
        const answered = await trx
          .selectFrom("remote_operations")
          .select(["id", "operation", "status"])
          .where("executor", "=", args.executor)
          .where("lease_token", "=", args.leaseToken)
          .where("poll_id", "=", args.pollId)
          .execute();
        if (answered.length > 0)
          return answered.filter((job) => job.status === "running");
        const next = await trx
          .selectFrom("remote_operations")
          .select(["id", "operation"])
          .where("executor", "=", args.executor)
          .where("lease_token", "=", args.leaseToken)
          .where("status", "=", "pending")
          .where("expires_at", ">", sql<Date>`now()`)
          .orderBy("created_at")
          .limit(max)
          .forUpdate()
          .skipLocked()
          .execute();
        if (next.length === 0) return [];
        await trx
          .updateTable("remote_operations")
          .set({ status: "running", poll_id: args.pollId })
          .where(
            "id",
            "in",
            next.map((job) => job.id),
          )
          .execute();
        return next;
      });
      if (jobs.length > 0 && args.signal?.aborted) {
        // Nobody will receive these: they wait for the next poll.
        await this.db
          .updateTable("remote_operations")
          .set({ status: "pending", poll_id: null })
          .where(
            "id",
            "in",
            jobs.map((job) => job.id),
          )
          .where("poll_id", "=", args.pollId)
          .where("status", "=", "running")
          .execute();
        return [];
      }
      if (jobs.length > 0)
        return jobs.map((job) => ({
          id: job.id,
          operation: RemoteOperationSchema.parse(job.operation),
        }));
      if (Date.now() >= deadline) return [];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Executor side: record one operation's outcome and drop its payload.
   * Idempotent: a receipt retried after its response was lost succeeds.
   */
  async complete(
    args: RemoteExecutorLease & {
      operationId: string;
      response?: unknown;
      error?: string;
    },
  ): Promise<void> {
    const status = args.error === undefined ? "completed" : "failed";
    const updated = await this.db
      .updateTable("remote_operations")
      .set({
        status,
        // A bare string result must reach jsonb as JSON, not raw text.
        response: jsonColumn(storableJson(args.response)),
        error: args.error === undefined ? null : withoutNul(args.error),
        // The payload (uploads may carry a member's personal login, ADR
        // 0184) leaves Postgres once the operation has run.
        operation: sql`jsonb_build_object('kind', operation->'kind')`,
      })
      .where("id", "=", args.operationId)
      .where("executor", "=", args.executor)
      .where("lease_token", "=", args.leaseToken)
      .where("status", "=", "running")
      .returning("id")
      .executeTakeFirst();
    if (updated) return;
    const recorded = await this.db
      .selectFrom("remote_operations")
      .select("id")
      .where("id", "=", args.operationId)
      .where("executor", "=", args.executor)
      .where("lease_token", "=", args.leaseToken)
      .where("status", "=", status)
      .where(
        "error",
        args.error === undefined ? "is" : "=",
        args.error === undefined ? null : withoutNul(args.error),
      )
      .executeTakeFirst();
    if (!recorded) throw new RemoteReceiptRefusedError();
  }

  /**
   * The executor restarted under a new lease (ADR 0192): every operation the
   * old one was sent or took fails as uncertain, in the caller's transaction,
   * and is never delivered again. Its late receipts are refused.
   */
  static async failLease(args: {
    transaction: Transaction<DB>;
    executor: string;
    leaseToken: string;
  }): Promise<number> {
    const failed = await args.transaction
      .updateTable("remote_operations")
      .set({
        status: "failed",
        error: EXECUTOR_RESTARTED_ERROR,
        operation: sql`jsonb_build_object('kind', operation->'kind')`,
      })
      .where("executor", "=", args.executor)
      .where("lease_token", "=", args.leaseToken)
      .where("status", "in", ["pending", "running"])
      .executeTakeFirst();
    return Number(failed.numUpdatedRows);
  }

  /**
   * Drop operations whose controller stopped waiting without deleting them
   * (its instance stopped): their payloads are project content. Runs from
   * dispatches and polls, at most once a minute per instance; hosts may also
   * call it on their own schedule.
   */
  async sweep(): Promise<void> {
    this.lastSweep = Date.now();
    await this.db
      .deleteFrom("remote_operations")
      .where("expires_at", "<", sql<Date>`now() - interval '10 minutes'`)
      .execute();
  }

  private sweepSoon(): void {
    if (Date.now() - this.lastSweep < SWEEP_EVERY_MS) return;
    void this.sweep().catch(() => {});
  }
}
