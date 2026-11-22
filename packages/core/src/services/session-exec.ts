import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  ACTIVE_TURN_STATUSES,
  type SessionMessageAuthor,
  sessionMessageAuthorSchema,
} from "@catamorphic/agent-protocol";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { shellQuote } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  commandSideProcesses,
  followProcess,
  type SandboxEgress,
  type SandboxProcessProvider,
  type SandboxSide,
} from "@catamorphic/sandbox";
import {
  PROJECT_APP_DATA_DIR,
  PROJECT_WORKSPACE_ROOT,
} from "@catamorphic/workflow/project-layout";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import { assertSessionWorkspaceAccess } from "./agent-session-access.js";
import {
  type AgentSessionsService,
  isCurrentSetupRun,
  parseSetupRun,
  type SetupRunFact,
} from "./agent-sessions-service.js";
import {
  ChatAudienceSchema,
  ChatKeySchema,
  keyedChatOwnerId,
} from "./chat-delivery.js";
import type { HostCallFollowOutcome } from "./host-call-waits.js";
import { HostCallParkedError } from "./host-call-waits.js";
import { outOfDiskFor, withOutOfDisk } from "./out-of-disk.js";
import { withProgram } from "./program-reader.js";
import { sandboxSecretsPrelude } from "./sandbox-secrets.js";
import {
  actionKey,
  canonical,
  json,
  namesOneChat,
  SessionKeyNotFoundError,
} from "./session-operations.js";
import {
  markWorkspaceUsed,
  type SessionWorkspaceHandle,
  SessionWorkspaceUnavailableError,
} from "./session-workspace.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";
import { narrowSandboxEgress } from "./workspace-setup.js";

const tracer = getTracer("@catamorphic/core");

/*
 * `host["catamorphic.sessions"].exec` (ADR 0324): a workflow's command in
 * a chat's workspace. Each execution is a session action, recorded in the
 * chat's log and answered once per idempotency key. It runs as a
 * background process whose streams go to files in the session directory;
 * a command that outlives its boundary attempt parks the step, and the
 * `session-exec:` follower reads it to its end from any replica.
 */

/** The prefix of the keys a parked execution waits by. */
export const SESSION_EXEC_WAIT_PREFIX = "session-exec:";

/** Characters of each stream the result keeps, from its end. */
export const EXEC_OUTPUT_LIMIT = 16_000;

/** Where `$WORK_PROGRAM` is, relative to the workspace root. */
export const PROGRAM_DIRECTORY = ".work-program";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 14_400;
/** How long past its own timeout a command's network may stay wide. */
const WIDENING_GRACE_MS = 60_000;
/** A start that left no process behind this long ago did not happen. */
const STALE_START_MS = 5 * 60_000;
/** How soon a command waiting for its workspace looks again. */
const WORKSPACE_RETRY_MS = 5_000;
/** Time left in the boundary attempt for recording what was followed. */
const ATTEMPT_MARGIN_MS = 20_000;

const ENV_NAME = /^(?!WORK_PROGRAM$)[A-Za-z_][A-Za-z0-9_]*$/;

/** A path beneath the checkout: relative, no `..`. */
const RelativePath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").includes("..") &&
      !/[\0\n]/.test(value),
    { message: "cwd is a path beneath the checkout" },
  );

export const SESSION_EXEC_SCHEMA = z
  .strictObject({
    sessionId: z.string().uuid().optional(),
    key: ChatKeySchema.optional(),
    audience: ChatAudienceSchema.optional(),
    expectedStateRevision: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(1).max(300),
    command: z.string().min(1).max(64_000),
    in: z.enum(["session", "setup"]),
    cwd: RelativePath.optional(),
    env: z
      .record(
        z.string().regex(ENV_NAME, "env names are shell variable names"),
        z.string().max(64_000),
      )
      .optional(),
    timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
  })
  .superRefine(namesOneChat);

export type SessionExecInput = z.infer<typeof SESSION_EXEC_SCHEMA>;

/** What a finished execution answers (`SessionExecResult` to workflows). */
export interface SessionExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * Why it failed when the disk is to blame (ADR 0336): its machine is
   * short of disk, or its output says a write found no room.
   */
  outOfDisk?: string;
}

/** Where a started execution is, as `session_actions.progress` holds it. */
interface ExecProgress {
  phase: "starting" | "running";
  at: string;
  /** The sandbox and process it runs as. */
  sandboxId?: string;
  processId?: string;
  /** An adopted start whose process is gone but recorded its exit. */
  exited?: boolean;
  startedAt?: string;
  /** When it is stopped: its timeout, or its setup's time (ADR 0324). */
  deadlineAt?: string;
  in?: "session" | "setup";
  /** The setup build whose run started it; that run's end stops it. */
  build?: string;
  /** The widening of a command `in: "setup"` (ADR 0257). */
  widening?: string;
  /** The program commit its `$WORK_PROGRAM` copy is of, kept while it runs. */
  program?: string;
}

/** Why a command could not run here at all. */
export class SessionExecRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExecRefusedError";
  }
}

type ActionRow = Selectable<DB["session_actions"]>;

export class SessionExecService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      sessions: AgentSessionsService;
      projectManager: import("@catamorphic/git").ProjectManager;
    },
  ) {}

  /**
   * Run, or answer for, one execution as a workflow's host call. Returns
   * the result when the command ends within the attempt; otherwise throws
   * {@link HostCallParkedError} and the step waits for it.
   */
  async execute(input: {
    caller: Identity;
    projectId: string;
    runId: string;
    author: SessionMessageAuthor;
    causation: string[];
    signal: AbortSignal;
    deadlineAt: string;
    args: unknown;
  }): Promise<Json> {
    const parsed = SESSION_EXEC_SCHEMA.parse(input.args);
    return withSpan(
      {
        tracer,
        name: "session.exec",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.run.id": input.runId,
          "catamorphic.exec.in": parsed.in,
        },
      },
      async () => {
        const sessionId =
          parsed.sessionId ??
          (await this.deps.sessions.keyedChatId({
            projectId: input.projectId,
            key: parsed.key ?? "",
            ownerId: keyedChatOwnerId({
              caller: input.caller,
              audience: parsed.audience,
            }),
          }));
        if (!sessionId) throw new SessionKeyNotFoundError(parsed.key ?? "");
        const session = await this.deps.db
          .selectFrom("agent_sessions")
          .select([
            "id",
            "external_user_id",
            "agent_id",
            "status",
            "setup_run",
            "state_revision",
          ])
          .where("id", "=", sessionId)
          .where("project_id", "=", input.projectId)
          .executeTakeFirst();
        if (!session) throw new SessionKeyNotFoundError(parsed.key ?? "");
        const run = await this.deps.db
          .selectFrom("workflow_runs")
          .select(["setup_session_id", "setup_build"])
          .where("id", "=", input.runId)
          .executeTakeFirstOrThrow();
        // Only a run Work stamped as this chat's setup, for the workspace
        // build in progress, is its setup run: never a caller's label.
        const fromSetup = isCurrentSetupRun({
          sessionId,
          setupRun: parseSetupRun(session.setup_run),
          run: setupFact(run),
        });
        // Whom a person's terminal is for (ADR 0209): a project chat for
        // project automations holding sessions:write, a member's chat for
        // that member's workflows. A chat's own setup run reaches it.
        if (!fromSetup)
          assertSessionWorkspaceAccess({
            identity: input.caller,
            projectId: input.projectId,
            externalUserId: session.external_user_id,
            agentId: session.agent_id,
          });
        if (session.status !== "active")
          throw new SessionExecRefusedError("This chat is closed.");
        if (
          parsed.expectedStateRevision !== undefined &&
          parsed.expectedStateRevision !== Number(session.state_revision)
        )
          throw new Error(
            "Session state changed; inspect it before retrying this action",
          );
        const key = actionKey({
          author: input.author,
          idempotencyKey: parsed.idempotencyKey,
        });
        const recorded = json(parsed);
        await this.deps.db
          .insertInto("session_actions")
          .values({
            project_id: input.projectId,
            session_id: sessionId,
            operation: "exec",
            actor: json({ ...input.author, causation: input.causation }),
            input: recorded,
            idempotency_key: key,
          })
          .onConflict((conflict) =>
            conflict.columns(["project_id", "idempotency_key"]).doNothing(),
          )
          .execute();
        const action = await this.deps.db
          .selectFrom("session_actions")
          .selectAll()
          .where("project_id", "=", input.projectId)
          .where("idempotency_key", "=", key)
          .executeTakeFirstOrThrow();
        if (
          action.operation !== "exec" ||
          canonical(action.input) !== canonical(recorded)
        )
          throw new Error(
            "This idempotency key was already used for another action",
          );
        if (action.status === "completed") return action.result;
        // A failed execution runs again when retried, as any action does.
        if (action.status === "failed")
          await this.deps.db
            .updateTable("session_actions")
            .set({ status: "pending", error: null, progress: null })
            .where("id", "=", action.id)
            .where("status", "=", "failed")
            .execute();
        const budget =
          Date.parse(input.deadlineAt) - Date.now() - ATTEMPT_MARGIN_MS;
        const outcome = await this.advance({
          actionId: action.id,
          sliceMs: Math.max(0, Math.min(budget, 60_000)),
          signal: input.signal,
        });
        if (outcome.status === "done") return outcome.output;
        if (outcome.status === "failed") throw new Error(outcome.error);
        throw new HostCallParkedError(
          `${SESSION_EXEC_WAIT_PREFIX}${action.id}`,
        );
      },
    );
  }

  /** The follower of parked executions (ADR 0324). */
  follow(args: {
    waitKey: string;
    signal: AbortSignal;
    sliceMs: number;
  }): Promise<HostCallFollowOutcome> {
    const actionId = args.waitKey.slice(SESSION_EXEC_WAIT_PREFIX.length);
    return this.advance({
      actionId,
      sliceMs: args.sliceMs,
      signal: args.signal,
    });
  }

  /**
   * Move one execution on for at most `sliceMs`: start it when it has not
   * started (waiting for the workspace as a turn would), follow it, and
   * record its end. Safe to call from any replica, again and again.
   */
  private async advance(input: {
    actionId: string;
    sliceMs: number;
    signal: AbortSignal;
  }): Promise<HostCallFollowOutcome> {
    const action = await this.deps.db
      .selectFrom("session_actions")
      .selectAll()
      .where("id", "=", input.actionId)
      .executeTakeFirst();
    if (!action)
      return { status: "failed", error: "The command's record is gone" };
    if (action.status === "completed")
      return { status: "done", output: action.result };
    if (action.status === "failed")
      return {
        status: "failed",
        error: action.error ?? "The command failed",
      };
    const args = SESSION_EXEC_SCHEMA.parse(action.input);
    const timeoutMs = (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const progress = parseProgress(action.progress);
    if (!progress || (progress.phase === "starting" && isStale(progress))) {
      // Waiting for the workspace counts against the command's timeout.
      if (Date.now() - action.created_at.getTime() > timeoutMs)
        return this.fail({
          action,
          error:
            "The chat's workspace did not start within the command's timeout",
        });
      const started = await this.start({
        action,
        args,
        timeoutMs,
        claimed: progress,
      }).catch(async (error: unknown) => {
        // Starting, or waiting for a machine (ADR 0258): tried again each
        // slice, within the command's own timeout.
        if (
          (error instanceof SessionWorkspaceUnavailableError &&
            error.reason === "starting") ||
          error instanceof EnvironmentCapacityError
        )
          return this.unclaim(action).then(() => "waiting" as const);
        return this.fail({
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // Waiting for the workspace: look again in a few seconds.
      if (started === "waiting")
        return { status: "pending", retryAfterMs: WORKSPACE_RETRY_MS };
      if (started === "lost") return { status: "pending" };
      if ("status" in started) return started;
      return this.followRunning({ action, args, timeoutMs, ...started, input });
    }
    if (progress.phase === "starting")
      return { status: "pending", retryAfterMs: WORKSPACE_RETRY_MS };
    return this.followRunning({
      action,
      args,
      timeoutMs,
      progress,
      input,
    });
  }

  /** Start the command once: the first caller to claim it does. */
  private async start(input: {
    action: ActionRow;
    args: SessionExecInput;
    timeoutMs: number;
    claimed: ExecProgress | null;
  }): Promise<{ progress: ExecProgress } | "lost"> {
    const { action, args } = input;
    const claim: ExecProgress = {
      phase: "starting",
      at: new Date().toISOString(),
    };
    const claimed = await this.deps.db
      .updateTable("session_actions")
      .set({
        status: "running",
        progress: progressJson(claim),
        updated_at: new Date(),
      })
      .where("id", "=", action.id)
      .where("status", "in", ["pending", "running"])
      .where((eb) =>
        input.claimed
          ? eb(sql`progress->>'at'`, "=", input.claimed.at)
          : eb("progress", "is", null),
      )
      .returning("id")
      .executeTakeFirst();
    if (!claimed) return "lost";
    const setupFor = await this.setupFactOf(action);
    const tenantId = await this.tenantOf(action.project_id);
    const caller = await this.callerOf(action);
    const workspace = await this.deps.sessions.commandWorkspace({
      tenantId,
      projectId: action.project_id,
      sessionId: action.session_id,
      setupFor,
      in: args.in,
      start: true,
      ...(caller ? { caller } : {}),
    });
    const { handle, setup } = workspace;
    const processes = processesOf(handle);
    await markWorkspaceUsed({ db: this.deps.db, sessionId: action.session_id });
    // A setup's commands end with its time (ADR 0324).
    const deadline = Math.min(
      Date.now() + input.timeoutMs,
      setup ? Date.parse(setup.deadline) : Number.POSITIVE_INFINITY,
    );
    const base: Omit<ExecProgress, "phase" | "at"> = {
      sandboxId: handle.sandboxId,
      in: args.in,
      deadlineAt: new Date(deadline).toISOString(),
      ...(setup ? { build: setup.build } : {}),
    };
    // A start that stopped after its process began, on this replica or
    // another, left that process or its exit behind: adopt it.
    const adopted = await this.adopt({ handle, action });
    if (adopted) {
      const progress: ExecProgress = {
        phase: "running",
        at: new Date().toISOString(),
        startedAt: action.updated_at.toISOString(),
        ...base,
        ...adopted,
      };
      await this.writeProgress({ action, claim, progress });
      return { progress };
    }
    if (deadline <= Date.now())
      throw new SessionExecRefusedError(
        "The setup's time is up, so the command did not start",
      );
    const commit = await this.programCommitOf(action);
    // Named from the start, so a cleanup another start runs meanwhile
    // keeps this commit's copy (ADR 0336).
    if (commit)
      await this.deps.db
        .updateTable("session_actions")
        .set({ progress: progressJson({ ...claim, program: commit }) })
        .where("id", "=", action.id)
        .where(sql<boolean>`progress->>'at' = ${claim.at}`)
        .execute();
    const program = commit
      ? await this.copyProgram({
          handle,
          tenantId,
          projectId: action.project_id,
          commit,
          keep: await this.programsInUse({ action }),
        })
      : undefined;
    const network = args.in === "setup" ? setup?.network : undefined;
    await handle.provider.uploadFiles(
      handle.sandboxId,
      {
        "command.sh": `${args.command}\n`,
        "run.sh": execScript({
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(program ? { program } : {}),
          // A command in setup has no grants or secrets file (ADR 0257).
          loadSecrets: args.in === "session",
        }),
      },
      `${handle.sessionDirectory}/exec/${action.id}`,
    );
    // Network changes and starts are ordered per workspace (its sharers'
    // commands run in one sandbox, ADR 0322): a command never starts on a
    // sandbox another's widening holds, nor widens one a session command
    // runs in, and a narrowing waits for the last widening.
    const shared = await this.workspaceOf(action);
    return this.withNetworkLock(shared.key, async (trx) => {
      const running = await runningExecs(trx, {
        sessionIds: shared.sessionIds,
        except: action.id,
        sandboxId: handle.sandboxId,
      });
      // A command of a setup run starts only while that setup is the
      // chat's current one: one that ended, or ran out of time, already
      // stopped its commands and narrowed the sandbox (ADR 0324).
      if (setup) {
        const chat = await trx
          .selectFrom("agent_sessions")
          .select("setup_run")
          .where("id", "=", action.session_id)
          .executeTakeFirst();
        const live = parseSetupRun(chat?.setup_run ?? null);
        if (
          live?.build !== setup.build ||
          Date.parse(live.deadline) <= Date.now()
        )
          throw new SessionExecRefusedError(
            "The setup ended before the command started",
          );
      }
      // Nor while the Environment's own setup has it on the setup's
      // network (ADR 0257), unless it is that setup's own workflow.
      if (
        args.in === "session" &&
        (running.some((other) => other.widening) ||
          (!setup && (await setupWidened(trx, shared.key))))
      )
        throw new SessionExecRefusedError(
          "The chat's workspace is on its setup's network for a setup command; a command in the session runs once it is narrow again",
        );
      if (network && running.some((other) => other.in === "session"))
        throw new SessionExecRefusedError(
          "A command in the session is running in this workspace, so it cannot be given the setup's network",
        );
      const current = await trx
        .selectFrom("session_actions")
        .select("progress")
        .where("id", "=", action.id)
        .executeTakeFirstOrThrow();
      if (parseProgress(current.progress)?.at !== claim.at) return "lost";
      const widening = network
        ? await this.widen({ handle, network, until: deadline })
        : undefined;
      const started = await processes.startProcess({
        sandboxId: handle.sandboxId,
        command: `bash ${shellQuote(`${execDirectory(action.id)}/run.sh`)}`,
        cwd: handle.projectDirectory,
        name: processName(action.id),
        env: {
          ...(setup && args.in === "setup" ? setup.env : {}),
          ...(args.env ?? {}),
        },
      });
      const progress: ExecProgress = {
        phase: "running",
        at: new Date().toISOString(),
        processId: started.processId,
        startedAt: new Date().toISOString(),
        ...base,
        ...(widening ? { widening } : {}),
        ...(commit ? { program: commit } : {}),
      };
      await trx
        .updateTable("session_actions")
        .set({ progress: progressJson(progress), updated_at: new Date() })
        .where("id", "=", action.id)
        .execute();
      return { progress };
    });
  }

  /**
   * The process an earlier start of this execution left, found by its
   * name, or the exit it recorded: never started twice.
   */
  private async adopt(input: {
    handle: SessionWorkspaceHandle;
    action: ActionRow;
  }): Promise<Pick<ExecProgress, "processId" | "exited"> | undefined> {
    const { handle, action } = input;
    const processes = processesOf(handle);
    const found = (
      await processes.listProcesses({ sandboxId: handle.sandboxId })
    ).find((process) => process.name === processName(action.id));
    if (found) return { processId: found.processId };
    const exit = await handle.provider.executeCommand(
      handle.sandboxId,
      `cat ${shellQuote(`${execDirectory(action.id)}/exit`)} 2>/dev/null || true`,
      { cwd: handle.projectDirectory, timeout: 60 },
    );
    return exit.result.trim() ? { exited: true } : undefined;
  }

  private async writeProgress(input: {
    action: ActionRow;
    claim: ExecProgress;
    progress: ExecProgress;
  }): Promise<void> {
    await this.deps.db
      .updateTable("session_actions")
      .set({ progress: progressJson(input.progress), updated_at: new Date() })
      .where("id", "=", input.action.id)
      .where(sql<boolean>`progress->>'at' = ${input.claim.at}`)
      .execute();
  }

  private async widen(args: {
    handle: SessionWorkspaceHandle;
    network: { egress: SandboxEgress };
    until: number;
  }): Promise<string> {
    const { provider, sandboxId } = args.handle;
    if (!provider.widenEgress)
      throw new SessionExecRefusedError(
        "This machine cannot widen a sandbox's network, so the setup's network cannot be given",
      );
    const id = randomUUID();
    await provider.widenEgress({
      sandboxId,
      egress: args.network.egress,
      id,
      // The machine narrows by itself soon after the setup's time is up.
      until: new Date(args.until + WIDENING_GRACE_MS).toISOString(),
    });
    return id;
  }

  /**
   * Run `work` holding the workspace's network lock (a transaction-scoped
   * advisory lock), so widenings, narrowings and starts in one sandbox
   * happen one at a time on every replica.
   */
  private withNetworkLock<T>(
    workspaceSessionId: string,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.deps.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`work-exec-network:${workspaceSessionId}`}))`.execute(
        trx,
      );
      return work(trx);
    });
  }

  /**
   * The workspace a chat's commands run in (ADR 0322): its workspace
   * session, which keys the network lock, and every session sharing it.
   */
  private async workspaceOf(action: {
    session_id: string;
  }): Promise<{ key: string; sessionIds: string[] }> {
    const chat = await this.deps.db
      .selectFrom("agent_sessions")
      .select("workspace_session_id")
      .where("id", "=", action.session_id)
      .executeTakeFirst();
    const key = chat?.workspace_session_id ?? action.session_id;
    const sharers = await this.deps.db
      .selectFrom("agent_sessions")
      .select("id")
      .where((eb) =>
        eb.or([eb("id", "=", key), eb("workspace_session_id", "=", key)]),
      )
      .execute();
    return {
      key,
      sessionIds: [
        ...new Set([action.session_id, ...sharers.map((row) => row.id)]),
      ],
    };
  }

  /** Follow a started command for one slice; record its end. */
  private async followRunning(args: {
    action: ActionRow;
    args: SessionExecInput;
    timeoutMs: number;
    progress: ExecProgress;
    input: { sliceMs: number; signal: AbortSignal };
  }): Promise<HostCallFollowOutcome> {
    const { action, progress } = args;
    const startedAt = Date.parse(progress.startedAt ?? progress.at);
    const deadline = progress.deadlineAt
      ? Date.parse(progress.deadlineAt)
      : startedAt + args.timeoutMs;
    const caller = await this.callerOf(action);
    const reached = await this.deps.sessions
      .commandWorkspace({
        tenantId: await this.tenantOf(action.project_id),
        projectId: action.project_id,
        sessionId: action.session_id,
        setupFor: await this.setupFactOf(action),
        in: "session",
        start: false,
        ...(caller ? { caller } : {}),
      })
      .then(
        (workspace) => workspace.handle,
        () => undefined,
      );
    const stopped = (stderr: string) =>
      this.finish({
        action,
        args: args.args,
        progress,
        result: {
          exitCode: null,
          stdout: "",
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut: false,
        },
      });
    if (!reached || reached.sandboxId !== progress.sandboxId) {
      // The caller lost the chat, or the sandbox is another: whatever it
      // started there stops, and its widening ends (finish narrows).
      await this.kill({ action, progress });
      return stopped(
        reached
          ? "The chat's workspace went away while the command ran (given back, replaced, or lost with its machine)."
          : "The run can no longer reach this chat's workspace, so its command was stopped.",
      );
    }
    const handle = reached;
    const processes = processesOf(handle);
    await markWorkspaceUsed({ db: this.deps.db, sessionId: action.session_id });
    const followed = progress.processId
      ? await followProcess({
          processes,
          sandboxId: handle.sandboxId,
          processId: progress.processId,
          // Its streams go to files; only its end is read here.
          cursor: 0,
          timeoutMs: Math.max(
            0,
            Math.min(args.input.sliceMs, deadline - Date.now()),
          ),
          signal: args.input.signal,
        })
      : undefined;
    if (followed?.aborted) return { status: "pending" };
    const ended = followed ? !followed.timedOut : true;
    const overdue = !ended && Date.now() >= deadline;
    if (!ended && !overdue) return { status: "pending" };
    if (overdue) await this.kill({ action, progress });
    const read = async (file: "stdout" | "stderr" | "exit") =>
      handle.provider
        .executeCommand(
          handle.sandboxId,
          `tail -c ${EXEC_OUTPUT_LIMIT} ${shellQuote(`${execDirectory(action.id)}/${file}`)} 2>/dev/null || true`,
          { cwd: handle.projectDirectory, timeout: 60 },
        )
        .then(
          (result) => result.result,
          () => "",
        );
    const recorded = followed
      ? undefined
      : Number.parseInt(await read("exit"), 10);
    return this.finish({
      action,
      args: args.args,
      progress,
      handle,
      result: {
        exitCode: overdue
          ? null
          : followed
            ? followed.exitCode
            : Number.isNaN(recorded) || recorded === undefined
              ? null
              : recorded,
        stdout: await read("stdout"),
        stderr: await read("stderr"),
        durationMs: Date.now() - startedAt,
        timedOut: overdue,
      },
    });
  }

  /** Stop an execution's process, wherever its sandbox is now. */
  private async kill(input: {
    action: ActionRow;
    progress: ExecProgress;
  }): Promise<void> {
    if (!input.progress.processId || !input.progress.sandboxId) return;
    const sandbox = await this.deps.sessions.chatSandbox({
      projectId: input.action.project_id,
      sessionId: input.action.session_id,
    });
    if (sandbox?.sandboxId !== input.progress.sandboxId) return;
    await processesOf(sandbox)
      .signalProcess({
        sandboxId: sandbox.sandboxId,
        processId: input.progress.processId,
        signal: "SIGKILL",
      })
      .catch(() => {});
  }

  /**
   * After a chat's setup run ended however it ended (ADR 0324): every
   * command it started is stopped and recorded, and a sandbox it widened
   * is narrowed, failing closed: a sandbox that cannot be narrowed is
   * stopped and this throws, so preparation never goes on with it wide.
   */
  async endSetup(input: {
    tenantId: string;
    projectId: string;
    sessionId: string;
    build: string;
    network: boolean;
  }): Promise<void> {
    // The setup is no longer the chat's current one, so no command of it
    // starts from now (the start checks under the lock); one that started
    // already has recorded its process once the lock is free.
    const shared = await this.workspaceOf({
      session_id: input.sessionId,
    });
    await this.withNetworkLock(shared.key, async () => {});
    const actions = await this.deps.db
      .selectFrom("session_actions")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("operation", "=", "exec")
      .where("status", "in", ["pending", "running"])
      .where(sql<boolean>`progress->>'build' = ${input.build}`)
      .execute();
    for (const action of actions) {
      const progress = parseProgress(action.progress);
      if (!progress) continue;
      await this.kill({ action, progress });
      await this.finish({
        action,
        args: SESSION_EXEC_SCHEMA.parse(action.input),
        progress,
        result: {
          exitCode: null,
          stdout: "",
          stderr:
            "The setup ended before the command did, so the command was stopped.",
          durationMs:
            Date.now() - Date.parse(progress.startedAt ?? progress.at),
          timedOut: false,
        },
      });
    }
    if (!input.network) return;
    const sandbox = await this.deps.sessions.chatSandbox({
      projectId: input.projectId,
      sessionId: input.sessionId,
    });
    if (!sandbox) return;
    await this.withNetworkLock(shared.key, () =>
      narrowSandboxEgress({
        provider: sandbox.provider,
        sandboxId: sandbox.sandboxId,
        id: randomUUID(),
      }),
    );
  }

  /**
   * Record the execution's end in its action and the chat's log, its
   * output masked by every secret value the chat received (ADR 0206). Its
   * widening ends; the sandbox narrows once no other holds one.
   */
  private async finish(args: {
    action: ActionRow;
    args: SessionExecInput;
    progress: ExecProgress;
    result: SessionExecResult;
    /** The workspace it ran in, when it was reached. */
    handle?: SessionWorkspaceHandle;
  }): Promise<HostCallFollowOutcome> {
    const { action } = args;
    if (args.progress.widening) await this.endWidening(args);
    const mask = await this.deps.sessions.chatSecretMask({
      tenantId: await this.tenantOf(action.project_id),
      projectId: action.project_id,
      sessionId: action.session_id,
    });
    const failed = args.result.exitCode !== 0 || args.result.timedOut;
    const outOfDisk = failed
      ? await outOfDiskFor({
          db: this.deps.db,
          sessionId: action.session_id,
          texts: [args.result.stderr, args.result.stdout],
        })
      : undefined;
    const result: SessionExecResult = {
      ...args.result,
      stdout: mask.text(args.result.stdout),
      stderr: mask.text(args.result.stderr),
      ...(outOfDisk ? { outOfDisk } : {}),
    };
    const output = json(result);
    const actor = actorOf(action);
    await this.deps.db.transaction().execute(async (trx) => {
      const owned = await trx
        .updateTable("session_actions")
        .set({
          status: "completed",
          result: output,
          error: null,
          lease_expires_at: null,
          lease_owner: null,
          updated_at: new Date(),
        })
        .where("id", "=", action.id)
        .where("status", "in", ["pending", "running"])
        .returning("id")
        .executeTakeFirst();
      if (!owned) return;
      await this.deps.sessions.recordActionWithin(trx, {
        sessionId: action.session_id,
        actionId: action.id,
        status: "completed",
        actor: actor.author,
        text: execLabel({ args: args.args, result }),
        data: {
          sessionAction: {
            id: action.id,
            operation: "exec",
            status: "completed",
            result: {
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
            },
          },
          causation: actor.causation,
        } satisfies JsonObject,
      });
    });
    const final = await this.deps.db
      .selectFrom("session_actions")
      .select(["result", "status", "error"])
      .where("id", "=", action.id)
      .executeTakeFirstOrThrow();
    // Its result is kept; its streams' files leave the workspace (ADR 0336).
    if (final.status === "completed")
      await this.removeOutput(action, args.handle);
    return final.status === "completed"
      ? { status: "done", output: final.result }
      : { status: "failed", error: final.error ?? "The command failed" };
  }

  /**
   * Remove an execution's folder from the chat's workspace once its result
   * is recorded: a test run's output would otherwise stay there for the
   * life of the workspace. Best effort; a workspace that went away took it.
   */
  private async removeOutput(
    action: ActionRow,
    reached?: SessionWorkspaceHandle,
  ): Promise<void> {
    const handle =
      reached ??
      (await this.deps.sessions
        .chatSandbox({
          projectId: action.project_id,
          sessionId: action.session_id,
        })
        .catch(() => undefined));
    if (!handle) return;
    await handle.provider
      .executeCommand(
        handle.sandboxId,
        `rm -rf ${shellQuote(execDirectory(action.id))}`,
        { cwd: handle.projectDirectory, timeout: 60 },
      )
      .catch(() => {});
  }

  /**
   * End one command's widening: the sandbox narrows when no other running
   * command holds one, so parallel setup commands never cut each other.
   * A sandbox that cannot be narrowed is stopped (ADR 0257).
   */
  private async endWidening(args: {
    action: ActionRow;
    progress: ExecProgress;
  }): Promise<void> {
    const { action, progress } = args;
    const shared = await this.workspaceOf(action);
    await this.withNetworkLock(shared.key, async (trx) => {
      await trx
        .updateTable("session_actions")
        .set({ progress: sql<Json>`progress - 'widening'` })
        .where("id", "=", action.id)
        .execute();
      const others = await runningExecs(trx, {
        sessionIds: shared.sessionIds,
        except: action.id,
        ...(progress.sandboxId ? { sandboxId: progress.sandboxId } : {}),
      });
      if (others.some((other) => other.widening)) return;
      const sandbox = await this.deps.sessions.chatSandbox({
        projectId: action.project_id,
        sessionId: action.session_id,
      });
      if (!sandbox || sandbox.sandboxId !== progress.sandboxId) return;
      await narrowSandboxEgress({
        provider: sandbox.provider,
        sandboxId: sandbox.sandboxId,
        id: progress.widening ?? randomUUID(),
      }).catch(() => {
        // Stopped by narrowSandboxEgress: closed, as ADR 0257 wants.
      });
    });
  }

  /** Give a start back that found no workspace yet, for the next slice. */
  private async unclaim(action: ActionRow): Promise<void> {
    await this.deps.db
      .updateTable("session_actions")
      .set({ progress: null, updated_at: new Date() })
      .where("id", "=", action.id)
      .where(sql<boolean>`progress->>'phase' = 'starting'`)
      .execute();
  }

  private async fail(given: {
    action: ActionRow;
    error: string;
  }): Promise<HostCallFollowOutcome> {
    const { action } = given;
    // A start that found no room says so (ADR 0336).
    const args = {
      ...given,
      error: withOutOfDisk(
        given.error,
        await outOfDiskFor({
          db: this.deps.db,
          sessionId: action.session_id,
          texts: [given.error],
        }),
      ),
    };
    const actor = actorOf(action);
    await this.deps.db.transaction().execute(async (trx) => {
      const failed = await trx
        .updateTable("session_actions")
        .set({
          status: "failed",
          error: args.error,
          progress: null,
          updated_at: new Date(),
        })
        .where("id", "=", action.id)
        .where("status", "in", ["pending", "running"])
        .returning("id")
        .executeTakeFirst();
      if (!failed) return;
      await this.deps.sessions.recordActionWithin(trx, {
        sessionId: action.session_id,
        actionId: action.id,
        status: "failed",
        actor: actor.author,
        text: `A workflow's command could not run: ${args.error.slice(0, 500)}`,
        data: {
          sessionAction: {
            id: action.id,
            operation: "exec",
            status: "failed",
          },
          causation: actor.causation,
        },
      });
    });
    return { status: "failed", error: args.error };
  }

  /**
   * Copy the program the run executes (its `.work/` at its deployed
   * commit) into its own folder, `.work-program/<commit>`, outside the
   * checkout, once per commit per sandbox, write bits removed. It appears
   * whole or not at all: uploaded beside it, then renamed into place.
   * Returns its path from the project folder, for `$WORK_PROGRAM`.
   */
  private async copyProgram(args: {
    handle: SessionWorkspaceHandle;
    tenantId: string;
    projectId: string;
    commit: string;
    /** Commits whose copies other running executions use. */
    keep: readonly string[];
  }): Promise<string> {
    const folder = `../${PROGRAM_DIRECTORY}/${args.commit}`;
    let program: Record<string, string> | undefined;
    // Where the command runs, and beside the agent: in a sandbox that runs
    // commands apart (ADR 0332) the agent's copy is the one its commands
    // cannot change. One container is asked twice otherwise.
    for (const side of ["commands", "agent"] as const) {
      program = await this.copyProgramTo({ ...args, side, folder, program });
    }
    return folder;
  }

  /** Program commits of the other executions running in this workspace. */
  /**
   * The program commits a workspace's chats may still read (ADR 0336): those
   * of its executions still running or starting, of any that ran within the
   * retention, and of any that ran since the oldest turn still queued or
   * working there began (at most a week back), since a workflow hands the
   * path to a turn.
   */
  private async programsInUse(args: { action: ActionRow }): Promise<string[]> {
    const shared = await this.workspaceOf(args.action);
    const turn = await this.deps.db
      .selectFrom("agent_turns")
      .select(sql<Date | null>`min(created_at)`.as("since"))
      .where("session_id", "in", shared.sessionIds)
      .where("status", "in", ["queued", ...ACTIVE_TURN_STATUSES])
      .executeTakeFirst();
    const retention = new Date(
      Date.now() - PROGRAM_COPY_RETENTION_MINUTES * 60_000,
    );
    // A turn waiting for days keeps no more than a week back.
    const cap = new Date(Date.now() - PROGRAM_COPY_TURN_CAP_DAYS * 86_400_000);
    const since =
      turn?.since && turn.since < retention
        ? turn.since < cap
          ? cap
          : turn.since
        : retention;
    const rows = await this.deps.db
      .selectFrom("session_actions")
      .select("progress")
      .where("session_id", "in", shared.sessionIds)
      .where("operation", "=", "exec")
      .where("id", "!=", args.action.id)
      .where((eb) =>
        eb.or([eb("status", "=", "running"), eb("updated_at", ">=", since)]),
      )
      .execute();
    return [
      ...new Set(
        rows.flatMap((row) => parseProgress(row.progress)?.program ?? []),
      ),
    ];
  }

  /** One side's copy; returns the program's files once they were read. */
  private async copyProgramTo(args: {
    handle: SessionWorkspaceHandle;
    tenantId: string;
    projectId: string;
    commit: string;
    keep: readonly string[];
    side: SandboxSide;
    folder: string;
    program: Record<string, string> | undefined;
  }): Promise<Record<string, string> | undefined> {
    const { handle, folder, side } = args;
    // A copy used again is used now: its time is what a cleanup reads for
    // a copy Work has no record of (ADR 0336).
    const present = await handle.provider.executeCommand(
      handle.sandboxId,
      `test -d ${shellQuote(folder)} && { touch -c ${shellQuote(folder)} 2>/dev/null; echo present; } || true`,
      { cwd: handle.projectDirectory, timeout: 60, side },
    );
    if (present.result.trim() === "present") return args.program;
    const program = args.program ?? (await this.programFiles(args));
    const root = path.posix.dirname(handle.projectDirectory);
    const staging = `${PROGRAM_DIRECTORY}/.staging-${randomUUID()}`;
    await handle.provider.uploadFiles(
      handle.sandboxId,
      { ...program, ".work-program-commit": args.commit },
      `${root}/${staging}`,
      { side },
    );
    // Renamed whole into place; a copy another start put there first wins.
    // A start that lost the race between its look and its rename moved its
    // copy into the winner's folder (permissions do not stop root), so it
    // takes that copy out again: `mv -T` would refuse, but not every
    // sandbox's `mv` has it.
    const nested = `${folder}/${path.posix.basename(staging)}`;
    const placed = await handle.provider.executeCommand(
      handle.sandboxId,
      [
        `chmod -R a-w ${shellQuote(`../${staging}`)}`,
        `if [ -d ${shellQuote(folder)} ]; then chmod -R u+w ${shellQuote(`../${staging}`)} && rm -rf ${shellQuote(`../${staging}`)}; else mv ${shellQuote(`../${staging}`)} ${shellQuote(folder)} || { test -d ${shellQuote(folder)} && chmod -R u+w ${shellQuote(`../${staging}`)} 2>/dev/null; rm -rf ${shellQuote(`../${staging}`)}; }; fi`,
        `if [ -e ${shellQuote(nested)} ]; then chmod -R u+w ${shellQuote(nested)} 2>/dev/null; rm -rf ${shellQuote(nested)}; fi`,
        `test -d ${shellQuote(folder)}`,
      ].join(" && "),
      { cwd: handle.projectDirectory, timeout: 120, side },
    );
    if (placed.exitCode !== 0)
      throw new Error(
        `Could not copy the program into the workspace: ${placed.result.trim().slice(-500)}`,
      );
    // A new copy per main commit would otherwise pile up for the life of
    // the workspace (ADR 0336): copies of other commits made over a day
    // ago go, and staging a start left, unless a running execution uses
    // them. A turn handed a path within the day keeps reading it.
    await handle.provider
      .executeCommand(
        handle.sandboxId,
        programCleanup({ keep: [args.commit, ...args.keep] }),
        {
          cwd: path.posix.dirname(handle.projectDirectory),
          timeout: 120,
          side,
        },
      )
      .catch(() => {});
    return program;
  }

  /** The program's files at a commit: its `.work/` less dependencies and data. */
  private async programFiles(args: {
    tenantId: string;
    projectId: string;
    commit: string;
  }): Promise<Record<string, string>> {
    const prefix = `${PROJECT_WORKSPACE_ROOT}/`;
    const appData = `${PROJECT_APP_DATA_DIR.slice(prefix.length)}/`;
    const files = await withProgram(
      this.deps.projectManager,
      args.tenantId,
      args.projectId,
      (repo) => repo.readFilesAtRef(args.commit, { prefix }),
    );
    return Object.fromEntries(
      Object.entries(files)
        .map(([file, content]) => [file.slice(prefix.length), content])
        .filter(
          (entry): entry is [string, string] =>
            entry[0] !== undefined &&
            !entry[0].split("/").includes("node_modules") &&
            !entry[0].startsWith(appData),
        ),
    );
  }

  private async programCommitOf(action: ActionRow): Promise<string | null> {
    const runId = runIdOf(action);
    if (!runId) return null;
    const row = await this.deps.db
      .selectFrom("workflow_runs")
      .innerJoin(
        "deployment_artifacts",
        "deployment_artifacts.id",
        "workflow_runs.deployment_artifact_id",
      )
      .select("deployment_artifacts.commit_sha")
      .where("workflow_runs.id", "=", runId)
      .executeTakeFirst();
    return row?.commit_sha ?? null;
  }

  /**
   * The calling run's caller, as its host calls act (ADR 0055): stamped
   * on the run at trigger time, so a follower on any replica has it.
   */
  private async callerOf(action: ActionRow): Promise<Identity | undefined> {
    const runId = runIdOf(action);
    if (!runId) return undefined;
    const row = await this.deps.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .select([
        "projects.tenant_id",
        "workflow_runs.external_user_id",
        "workflow_runs.caller_scope",
        "workflow_runs.caller_execution_scope",
        "workflow_runs.caller_connection_scope",
        "workflow_runs.caller_project_permissions",
      ])
      .where("workflow_runs.id", "=", runId)
      .executeTakeFirst();
    if (!row?.external_user_id) return undefined;
    return identityOfRun({ ...row, external_user_id: row.external_user_id });
  }

  /** The calling run's setup stamp, when Work started it as a setup. */
  private async setupFactOf(action: ActionRow): Promise<SetupRunFact | null> {
    const runId = runIdOf(action);
    if (!runId) return null;
    const row = await this.deps.db
      .selectFrom("workflow_runs")
      .select(["setup_session_id", "setup_build"])
      .where("id", "=", runId)
      .executeTakeFirst();
    return row ? setupFact(row) : null;
  }

  private async tenantOf(projectId: string): Promise<string> {
    const row = await this.deps.db
      .selectFrom("projects")
      .select("tenant_id")
      .where("id", "=", projectId)
      .executeTakeFirstOrThrow();
    return row.tenant_id;
  }
}

/** Minutes a copy of another commit's program stays in a workspace. */
const PROGRAM_COPY_RETENTION_MINUTES = 24 * 60;
/** The furthest back a working turn keeps program copies, in days. */
const PROGRAM_COPY_TURN_CAP_DAYS = 7;

/**
 * The script that removes old program copies from a workspace root (ADR
 * 0336): every `.work-program/<commit>` and leftover staging folder
 * modified over a day ago, except the commits named. It runs with any
 * POSIX `sh` and busybox `find`.
 */
export function programCleanup(input: { keep: readonly string[] }): string {
  const keep = [...new Set(input.keep)].map(shellQuote).join(" ");
  return [
    `for d in ${PROGRAM_DIRECTORY}/* ${PROGRAM_DIRECTORY}/.staging-*; do`,
    '  [ -d "$d" ] || continue',
    '  name=$(basename "$d")',
    "  kept=",
    `  for k in ${keep}; do [ "$name" = "$k" ] && kept=1; done`,
    '  [ -n "$kept" ] && continue',
    `  [ -n "$(find "$d" -maxdepth 0 -mmin +${PROGRAM_COPY_RETENTION_MINUTES})" ] || continue`,
    '  chmod -R u+w "$d" 2>/dev/null; rm -rf "$d"',
    "done",
    "exit 0",
  ].join("\n");
}

/** The execution's directory, from the project folder. */
function execDirectory(actionId: string): string {
  return `../.work-session/exec/${actionId}`;
}

/**
 * The script an execution runs from the project folder: the session's
 * environment files unless it runs on the setup's own network, then
 * `$WORK_PROGRAM`, the command from `cwd`, its streams to files.
 */
export function execScript(input: {
  cwd?: string;
  /** The program's folder from the project folder, for `$WORK_PROGRAM`. */
  program?: string;
  loadSecrets: boolean;
}): string {
  return [
    'work_exec=$(cd "$(dirname "$0")" && pwd -P) || exit 1',
    ...(input.loadSecrets ? [sandboxSecretsPrelude()] : []),
    ...(input.program
      ? [
          `WORK_PROGRAM=$(cd ${shellQuote(input.program)} && pwd -P) || exit 1`,
          "export WORK_PROGRAM",
        ]
      : []),
    ...(input.cwd ? [`cd -- ${shellQuote(input.cwd)} || exit 1`] : []),
    'bash "$work_exec/command.sh" >"$work_exec/stdout" 2>"$work_exec/stderr" </dev/null',
    "work_status=$?",
    'printf \'%s\' "$work_status" > "$work_exec/exit"',
    'exit "$work_status"',
    "",
  ].join("\n");
}

function processesOf(handle: SessionWorkspaceHandle): SandboxProcessProvider {
  const processes = handle.provider.processes;
  if (!processes)
    throw new SessionExecRefusedError(
      "This machine cannot run a workflow's commands in a chat's workspace",
    );
  // A workflow's commands live on the command side alone (ADR 0332).
  return commandSideProcesses(processes);
}

function progressJson(progress: ExecProgress): Json {
  return json(progress);
}

/** The process an execution runs as, found again by its name. */
function processName(actionId: string): string {
  return `work-exec-${actionId}`;
}

/** Other executions running in a chat's sandbox, and what they hold. */
async function runningExecs(
  db: Kysely<DB> | Transaction<DB>,
  input: { sessionIds: readonly string[]; except: string; sandboxId?: string },
): Promise<ExecProgress[]> {
  const rows = await db
    .selectFrom("session_actions")
    .select("progress")
    .where("session_id", "in", [...input.sessionIds])
    .where("operation", "=", "exec")
    .where("status", "=", "running")
    .where("id", "!=", input.except)
    .execute();
  return rows
    .map((row) => parseProgress(row.progress))
    .filter(
      (progress): progress is ExecProgress =>
        progress !== null &&
        (!input.sandboxId ||
          !progress.sandboxId ||
          progress.sandboxId === input.sandboxId),
    );
}

/**
 * Whether the Environment's own setup has the workspace's sandbox on its
 * network now (ADR 0257): only its commands run there meanwhile.
 */
async function setupWidened(
  db: Kysely<DB> | Transaction<DB>,
  workspaceSessionId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("agent_sessions")
    .select("id")
    .where("id", "=", workspaceSessionId)
    .where("setup_widened_until", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row !== undefined;
}

function parseProgress(value: Json | null): ExecProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = value.phase;
  const at = value.at;
  if ((phase !== "starting" && phase !== "running") || typeof at !== "string")
    return null;
  const text = (field: string) => {
    const entry = value[field];
    return typeof entry === "string" ? entry : undefined;
  };
  return {
    phase,
    at,
    ...(text("sandboxId") ? { sandboxId: text("sandboxId") } : {}),
    ...(text("processId") ? { processId: text("processId") } : {}),
    ...(text("startedAt") ? { startedAt: text("startedAt") } : {}),
    ...(text("deadlineAt") ? { deadlineAt: text("deadlineAt") } : {}),
    ...(text("build") ? { build: text("build") } : {}),
    ...(text("widening") ? { widening: text("widening") } : {}),
    ...(text("program") ? { program: text("program") } : {}),
    ...(value.in === "session" || value.in === "setup" ? { in: value.in } : {}),
    ...(value.exited === true ? { exited: true } : {}),
  };
}

function isStale(progress: ExecProgress): boolean {
  return Date.now() - Date.parse(progress.at) > STALE_START_MS;
}

function runIdOf(action: ActionRow): string | null {
  const actor = action.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return null;
  return typeof actor.runId === "string" ? actor.runId : null;
}

function actorOf(action: ActionRow): {
  author: SessionMessageAuthor;
  causation: string[];
} {
  const actor =
    action.actor &&
    typeof action.actor === "object" &&
    !Array.isArray(action.actor)
      ? action.actor
      : {};
  const { causation, ...author } = actor;
  return {
    author: sessionMessageAuthorSchema.parse(author),
    causation: Array.isArray(causation)
      ? causation.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** The chat log's line for an execution: what ran, where, how it ended. */
function execLabel(input: {
  args: SessionExecInput;
  result: SessionExecResult;
}): string {
  const line = input.args.command.split("\n")[0] ?? "";
  const shown = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  const more = input.args.command.includes("\n") ? " (and more lines)" : "";
  const how = input.result.timedOut
    ? "stopped at its timeout"
    : input.result.exitCode === null
      ? "stopped"
      : `exit ${input.result.exitCode}`;
  return `A workflow ran \`${shown}\`${more} in this chat's workspace${input.args.in === "setup" ? " as setup" : ""}: ${how}.`;
}

/** A run's caller from its row, as the boundary handler builds it. */
function identityOfRun(row: {
  tenant_id: string;
  external_user_id: string;
  caller_scope: Json | null;
  caller_execution_scope: Json | null;
  caller_connection_scope: Json | null;
  caller_project_permissions: Json | null;
}): Identity {
  return {
    tenantId: row.tenant_id,
    externalUserId: row.external_user_id,
    ...(Array.isArray(row.caller_scope)
      ? { scope: row.caller_scope as unknown as Identity["scope"] }
      : {}),
    ...(Array.isArray(row.caller_execution_scope)
      ? {
          executionScope:
            row.caller_execution_scope as unknown as Identity["executionScope"],
        }
      : {}),
    ...(Array.isArray(row.caller_connection_scope)
      ? {
          connectionScope:
            row.caller_connection_scope as unknown as Identity["connectionScope"],
        }
      : {}),
    ...(Array.isArray(row.caller_project_permissions)
      ? {
          projectPermissions:
            row.caller_project_permissions as unknown as Identity["projectPermissions"],
        }
      : {}),
  };
}

function setupFact(row: {
  setup_session_id: string | null;
  setup_build: string | null;
}): SetupRunFact | null {
  return row.setup_session_id && row.setup_build
    ? { sessionId: row.setup_session_id, build: row.setup_build }
    : null;
}
