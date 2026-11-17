import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type SessionMessageAuthor,
  sessionMessageAuthorSchema,
} from "@catamorphic/agent-protocol";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { shellQuote } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  followProcess,
  type SandboxEgress,
  type SandboxProcessProvider,
} from "@catamorphic/sandbox";
import { type Kysely, type Selectable, sql } from "kysely";
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
import { withProgram } from "./program-reader.js";
import { sandboxSecretsPrelude } from "./sandbox-secrets.js";
import {
  actionKey,
  canonical,
  json,
  namesOneChat,
  SessionKeyNotFoundError,
} from "./session-actions-service.js";
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
}

/** Where a started execution is, as `session_actions.progress` holds it. */
interface ExecProgress {
  phase: "starting" | "running";
  at: string;
  /** The sandbox and process it runs as. */
  sandboxId?: string;
  processId?: string;
  startedAt?: string;
  /** The widening of a command `in: "setup"` (ADR 0257). */
  widening?: string;
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
        progress: claim as unknown as Json,
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
    const { handle } = workspace;
    const processes = processesOf(handle);
    await markWorkspaceUsed({ db: this.deps.db, sessionId: action.session_id });
    const commit = await this.programCommitOf(action);
    if (commit)
      await this.copyProgram({
        handle,
        tenantId,
        projectId: action.project_id,
        commit,
      });
    const network = args.in === "setup" ? workspace.setup?.network : undefined;
    const dir = execDirectory(action.id);
    await handle.provider.uploadFiles(
      handle.sandboxId,
      {
        "command.sh": `${args.command}\n`,
        "run.sh": execScript({
          cwd: args.cwd,
          loadSecrets: !network,
        }),
      },
      `${handle.sessionDirectory}/exec/${action.id}`,
    );
    let widening: string | undefined;
    if (network) widening = await this.widen({ handle, network, input });
    const started = await processes.startProcess({
      sandboxId: handle.sandboxId,
      command: `bash ${shellQuote(`${dir}/run.sh`)}`,
      cwd: handle.projectDirectory,
      name: `Workflow command ${action.id.slice(0, 8)}`,
      env: { ...(network?.env ?? {}), ...(args.env ?? {}) },
    });
    const progress: ExecProgress = {
      phase: "running",
      at: new Date().toISOString(),
      sandboxId: handle.sandboxId,
      processId: started.processId,
      startedAt: new Date().toISOString(),
      ...(widening ? { widening } : {}),
    };
    await this.deps.db
      .updateTable("session_actions")
      .set({ progress: progress as unknown as Json, updated_at: new Date() })
      .where("id", "=", action.id)
      .execute();
    return { progress };
  }

  private async widen(args: {
    handle: SessionWorkspaceHandle;
    network: { egress: SandboxEgress; env: Record<string, string> };
    input: { timeoutMs: number };
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
      until: new Date(
        Date.now() + args.input.timeoutMs + WIDENING_GRACE_MS,
      ).toISOString(),
    });
    return id;
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
    const caller = await this.callerOf(action);
    const handle = await this.deps.sessions
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
    if (
      !handle ||
      !progress.processId ||
      handle.sandboxId !== progress.sandboxId
    )
      return this.finish({
        action,
        args: args.args,
        handle,
        progress,
        result: {
          exitCode: null,
          stdout: "",
          stderr:
            "The chat's workspace went away while the command ran (given back, replaced, or lost with its machine).",
          durationMs: Date.now() - startedAt,
          timedOut: false,
        },
      });
    const processes = processesOf(handle);
    await markWorkspaceUsed({ db: this.deps.db, sessionId: action.session_id });
    const remaining = startedAt + args.timeoutMs - Date.now();
    const followed = await followProcess({
      processes,
      sandboxId: handle.sandboxId,
      processId: progress.processId,
      // Its streams go to files; only its end is read here.
      cursor: 0,
      timeoutMs: Math.max(0, Math.min(args.input.sliceMs, remaining)),
      signal: args.input.signal,
    });
    if (followed.aborted) return { status: "pending" };
    const ended = !followed.timedOut;
    const overdue = !ended && Date.now() >= startedAt + args.timeoutMs;
    if (!ended && !overdue) return { status: "pending" };
    if (overdue)
      await processes
        .signalProcess({
          sandboxId: handle.sandboxId,
          processId: progress.processId,
          signal: "SIGKILL",
        })
        .catch(() => {});
    const tail = async (stream: "stdout" | "stderr") =>
      handle.provider
        .executeCommand(
          handle.sandboxId,
          `tail -c ${EXEC_OUTPUT_LIMIT} ${shellQuote(`${execDirectory(action.id)}/${stream}`)} 2>/dev/null || true`,
          { cwd: handle.projectDirectory, timeout: 60 },
        )
        .then(
          (result) => result.result,
          () => "",
        );
    return this.finish({
      action,
      args: args.args,
      handle,
      progress,
      result: {
        exitCode: overdue ? null : followed.exitCode,
        stdout: await tail("stdout"),
        stderr: await tail("stderr"),
        durationMs: Date.now() - startedAt,
        timedOut: overdue,
      },
    });
  }

  /** Record the execution's end in its action and the chat's log. */
  private async finish(args: {
    action: ActionRow;
    args: SessionExecInput;
    handle: SessionWorkspaceHandle | undefined;
    progress: ExecProgress;
    result: SessionExecResult;
  }): Promise<HostCallFollowOutcome> {
    const { action, result } = args;
    if (args.progress.widening && args.handle)
      await narrowSandboxEgress({
        provider: args.handle.provider,
        sandboxId: args.handle.sandboxId,
        id: args.progress.widening,
      }).catch(() => {
        // Stopped already, or narrowing at its deadline by itself.
      });
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
        .where("status", "=", "running")
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
    return final.status === "completed"
      ? { status: "done", output: final.result }
      : { status: "failed", error: final.error ?? "The command failed" };
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

  private async fail(args: {
    action: ActionRow;
    error: string;
  }): Promise<HostCallFollowOutcome> {
    const { action } = args;
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
   * commit) to `$WORK_PROGRAM`, once per commit per sandbox, write bits
   * removed. Outside the checkout, so no checkpoint or sync carries it.
   */
  private async copyProgram(args: {
    handle: SessionWorkspaceHandle;
    tenantId: string;
    projectId: string;
    commit: string;
  }): Promise<void> {
    const { handle } = args;
    const marker = `../${path.posix.basename(handle.sessionDirectory)}/program.commit`;
    const current = await handle.provider.executeCommand(
      handle.sandboxId,
      `cat ${shellQuote(marker)} 2>/dev/null || true`,
      { cwd: handle.projectDirectory, timeout: 60 },
    );
    if (current.result.trim() === args.commit) return;
    const files = await withProgram(
      this.deps.projectManager,
      args.tenantId,
      args.projectId,
      (repo) => repo.readFilesAtRef(args.commit, { prefix: ".work/" }),
    );
    const program = Object.fromEntries(
      Object.entries(files)
        .map(([file, content]) => [file.slice(".work/".length), content])
        .filter(
          ([file]) =>
            file !== undefined &&
            !file.split("/").includes("node_modules") &&
            !file.startsWith("app-data/"),
        ),
    );
    const root = path.posix.dirname(handle.projectDirectory);
    const next = `${PROGRAM_DIRECTORY}.next-${randomUUID().slice(0, 8)}`;
    if (Object.keys(program).length > 0)
      await handle.provider.uploadFiles(
        handle.sandboxId,
        program,
        `${root}/${next}`,
      );
    const replaced = await handle.provider.executeCommand(
      handle.sandboxId,
      [
        `mkdir -p ${shellQuote(`../${next}`)}`,
        `chmod -R a-w ${shellQuote(`../${next}`)}`,
        `if [ -e ${shellQuote(`../${PROGRAM_DIRECTORY}`)} ]; then chmod -R u+w ${shellQuote(`../${PROGRAM_DIRECTORY}`)} && rm -rf ${shellQuote(`../${PROGRAM_DIRECTORY}`)}; fi`,
        `mv ${shellQuote(`../${next}`)} ${shellQuote(`../${PROGRAM_DIRECTORY}`)}`,
        `mkdir -p "$(dirname ${shellQuote(marker)})"`,
        `printf '%s' ${shellQuote(args.commit)} > ${shellQuote(marker)}`,
      ].join(" && "),
      { cwd: handle.projectDirectory, timeout: 120 },
    );
    if (replaced.exitCode !== 0)
      throw new Error(
        `Could not copy the program into the workspace: ${replaced.result.trim().slice(-500)}`,
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
  loadSecrets: boolean;
}): string {
  return [
    'work_exec=$(cd "$(dirname "$0")" && pwd -P) || exit 1',
    ...(input.loadSecrets ? [sandboxSecretsPrelude()] : []),
    `if [ -d ${shellQuote(`../${PROGRAM_DIRECTORY}`)} ]; then WORK_PROGRAM=$(cd ${shellQuote(`../${PROGRAM_DIRECTORY}`)} && pwd -P); export WORK_PROGRAM; fi`,
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
  return processes;
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
    ...(text("widening") ? { widening: text("widening") } : {}),
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
