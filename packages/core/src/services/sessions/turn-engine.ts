import { randomUUID } from "node:crypto";
import {
  type AgentAttachment,
  type Attempt,
  type AttemptReason,
  INPUT_ITEM_KINDS,
  type InputItem,
  type Item,
  isInputItem,
  type JsonObject,
  type JsonValue,
  type NativeRef,
  type ProviderThread,
  type RuntimeRequest,
  type RuntimeRequestResponse,
  type SessionEvent,
  type Turn,
  type TurnError,
  type TurnOutcome,
} from "@catamorphic/agent-protocol";
import {
  type AttemptStart,
  type HarnessCapabilities,
  type HostCall,
  type HostToolResult,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommandFrame,
  type RunnerFrame,
  type ThreadBinding,
} from "@catamorphic/agent-protocol/runner";
import { type DB, type Json, jsonbText } from "@catamorphic/db";
import {
  getTracer,
  setSpanCorrelation,
  withSpan,
  withTelemetryContext,
} from "@catamorphic/otel";
import type { Span } from "@opentelemetry/api";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import type { Identity } from "../../identity.js";
import {
  type HeldTurnLease,
  type RenewedTurnLease,
  startTurnLeaseRenewal,
} from "../agent-turn-leases.js";
import { buildContextHandoff } from "./context-handoff.js";
import { NativeStateStore } from "./native-state.js";
import {
  type ApprovalPolicy,
  approvalPolicy,
  governApproval,
} from "./request-policy.js";
import {
  type RunnerChannel,
  type RunnerLocation,
  type RunnerRead,
  reattachInProcessRunner,
} from "./runner-channels.js";
import { SecretMask } from "./secret-mask.js";
import type { SessionLog } from "./session-log.js";
import {
  attemptFromRow,
  itemFromRow,
  providerThreadFromRow,
  requestFromRow,
  type SessionRow,
  turnFromRow,
  waitingNotificationTurn,
} from "./session-rows.js";
import { derivedId, ingestHarnessEvents } from "./turn-ingest.js";
import type { ClaimedTurn, TurnCommandKind, TurnQueue } from "./turn-queue.js";

const tracer = getTracer("@catamorphic/core");

/** What a runner's attempt row keeps about it (never streamed to clients). */
export interface RunnerState {
  location: RunnerLocation;
  /** Where reading continues: past the last complete frame ingested. */
  cursor: number;
  /** The harness, once its runner said hello: proof the start arrived. */
  hello: { harness: string; capabilities: HarnessCapabilities } | null;
  /**
   * Host calls taken whose result the runner has not acknowledged: answered
   * again after a takeover. Written per call, never as a whole.
   */
  calls: Record<string, HostCall>;
  /** Native state appends already applied: answered again, never applied twice. */
  applied?: Record<string, true>;
  /** Runs on its owner's sign-in or personal files (see {@link PreparedAttempt}). */
  ownerOnly?: boolean;
  /** Why only the owner's input may join it (see {@link PreparedAttempt}). */
  ownerOnlyBecause?: OwnerOnlyCause;
  /** Steered inputs the harness could not take; the attempt restarts with them. */
  restartWith: string[];
  /**
   * Its attempt ended and it was answered until it exited, or ended, or
   * found gone: nobody reattaches it again.
   */
  ended?: boolean;
  /** Steered inputs the harness took in (an accepted one never taken is queued again). */
  consumed: string[];
  interruptSentAt: string | null;
}

/** A host tool's answer, and whether the call's side effects are certain. */
export type HostToolHandler = (input: {
  name: string;
  input: JsonValue;
}) => Promise<HostToolResult>;

/** What preparation hands the engine for one attempt. */
export interface PreparedAttempt {
  /** The attempt's start, without the engine's own fields. */
  start: Omit<
    AttemptStart,
    | "protocol"
    | "sessionId"
    | "projectId"
    | "turnId"
    | "attemptId"
    | "reason"
    | "thread"
    | "input"
  >;
  /** Start the runner (in-process, or a process in the session's sandbox). */
  launch(): Promise<RunnerChannel>;
  /** What the agent is told before the input (a moved workspace, files left out). */
  notes?: string[];
  /** The workspace's commit before the turn, which a rollback restores. */
  checkpointBefore?: string | null;
  /**
   * The attempt runs on its owner's sign-in or personal files: only input
   * the owner wrote may join it (ADR 0199).
   */
  ownerOnly?: boolean;
  /**
   * Why: the owner's own harness sign-in (ADR 0199), or values that are
   * theirs in the workspace (personal files, secrets; ADRs 0184, 0206).
   */
  ownerOnlyBecause?: OwnerOnlyCause;
  /**
   * Every secret value the chat could repeat, by name (ADR 0206): masked
   * wherever the attempt's output is recorded, whoever wrote its input.
   */
  secretValues?: Readonly<Record<string, readonly string[]>>;
}

/** What makes an attempt its owner's alone. */
export type OwnerOnlyCause = "sign-in" | "credentials";

/** What a settled turn's finalization produced. */
export interface FinalizedTurn {
  outcome: TurnOutcome;
  checkpointAfter: string | null;
  /** Finalization itself failed (a checkpoint that could not be saved). */
  failure?: TurnError;
}

export interface TurnEngineHost {
  /** The identity a session's work runs as (its owner, ADR 0173). */
  owner(session: SessionRow): Promise<Identity | null>;
  /** The harness the session's agent runs on and how its turns recover. */
  harnessOf(input: { identity: Identity; session: SessionRow }): Promise<{
    harness: string;
    agentId: string | null;
    recovery: "continue" | "stop";
    /** Why the agent cannot run now: the turn fails with it. */
    unavailable?: string;
  }>;
  prepare(input: {
    identity: Identity;
    session: SessionRow;
    turn: Turn;
    attempt: Attempt;
    signal: AbortSignal;
  }): Promise<PreparedAttempt>;
  /** Find a sandbox runner again through the session's Allocation. */
  reattach(input: {
    identity: Identity;
    session: SessionRow;
    location: Extract<RunnerLocation, { kind: "sandbox_process" }>;
  }): Promise<RunnerChannel | undefined>;
  hostTool(input: {
    identity: Identity;
    session: SessionRow;
    turn: Turn;
    name: string;
    input: JsonValue;
  }): Promise<HostToolResult>;
  finalize(input: {
    identity: Identity;
    session: SessionRow;
    turn: Turn;
    inputText: string;
    completion: { status: "completed" | "failed" | "interrupted" };
  }): Promise<FinalizedTurn>;
  /**
   * Whether the chat's owner wrote an input (ADR 0199): only theirs may
   * reach an attempt that runs on their sign-in or files.
   */
  authoredByOwner(input: {
    session: SessionRow;
    item: InputItem;
  }): Promise<boolean>;
  /** After a turn settled, outside its transaction: delegation, notifications, hooks. */
  settled(input: {
    identity: Identity;
    session: SessionRow;
    turn: Turn;
    reply: Item | null;
    retrying: boolean;
  }): Promise<void>;
  /** This holder stopped working the turn, however it ended: let go of what it kept. */
  released?(input: { sessionId: string; turnId: string }): void;
  /**
   * Every secret value a session's sandbox could hold (ADR 0206), for a
   * holder that took a running turn over and so never prepared it.
   */
  secretValues?(input: {
    identity: Identity;
    session: SessionRow;
  }): Promise<Readonly<Record<string, readonly string[]>>>;
  /** Approvals that opened and wait on approvers, after they committed. */
  approvalsOpened?(input: {
    session: SessionRow;
    requests: RuntimeRequest[];
  }): Promise<void>;
  /**
   * A failed attempt nothing ran in, whose failure the engine does not
   * retry by itself: whether the host knows it is passing and asks for one
   * more attempt (ADR 0227). Asked at most once per turn.
   */
  retryFailure?(input: {
    identity: Identity;
    session: SessionRow;
    turn: Turn;
    error: TurnError;
  }): Promise<{ afterMs: number; activity: string } | undefined>;
}

/** The model-facing text of an input item (its envelope included, ADR 0217). */
export type InputText = (item: InputItem) => string;

interface LocalTurn {
  claim: ClaimedTurn;
  abort: AbortController;
  wake: () => void;
  waiter?: Promise<void>;
  /** The runner of the attempt running now, if any. */
  channel?: RunnerChannel;
  /** This process is stopping: hand reattachable work back instead. */
  handingBack: boolean;
  /** Its attempt ended and it finalizes: it settles here, never handed back. */
  finalizing: boolean;
  /** Host call results sent and not acknowledged yet, by frame id: sent again. */
  results: Map<string, RunnerCommandFrame>;
  resultsSentAt: number;
  /**
   * The secret values masked in the running attempt's output (ADR 0206);
   * undefined until this holder prepared or took over the attempt.
   */
  mask?: SecretMask;
}

/**
 * The runner state to save. Calls are added and removed one at a time, so
 * this keeps the recorded ones and adds only `added`: a whole-state write
 * never brings back a call answered meanwhile.
 */
function runnerWrite(
  runner: RunnerState,
  added: ReadonlyArray<[string, HostCall]> = [],
  /** Appends applied with the frames that carried them. */
  applied: readonly string[] = [],
) {
  const { calls: _calls, applied: _applied, ...rest } = runner;
  return sql<Json>`${jsonbText(rest)}::jsonb || jsonb_build_object(
    'calls', coalesce(runner -> 'calls', '{}'::jsonb) || ${jsonbText(Object.fromEntries(added))}::jsonb,
    'applied', coalesce(runner -> 'applied', '{}'::jsonb) || ${jsonbText(Object.fromEntries(applied.map((callId) => [callId, true])))}::jsonb)`;
}

/**
 * What an applied append is recorded as until its result is acknowledged:
 * a holder that takes over answers it again, and its entries are stored
 * already, so they are not kept twice.
 */
const APPLIED_APPEND: HostCall = { kind: "native_state.append", entries: [] };

/** The text a continuation turn gives the agent (ADR 0198). */
export const CONTINUATION_PROMPT =
  "Your previous turn was interrupted because the machine running it stopped. Continue where you left off. First check what was already done (files, commands, messages) so you do not repeat anything that had side effects.";

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
/**
 * The longest a host's retry of a failed attempt waits (ADR 0227): the
 * turn holds its lease and reads as active meanwhile.
 */
const HOST_RETRY_MAX_MS = 60_000;
const MAX_TRANSIENT_RETRIES = 5;
const INTERRUPT_GRACE_MS = 30_000;
/** How long a reattached runner that never said hello has to show it got its start. */
const START_GRACE_MS = 15_000;
/** How long a host result waits for the runner's acknowledgement before it is sent again. */
const RESULT_RESEND_MS = 2_000;
/**
 * How long a runner whose attempt ended is answered while its harness
 * winds down, before it is stopped. Longer than a harness's own wait for
 * its process to exit (Claude Code's is 10 s).
 */
const RUNNER_EXIT_GRACE_MS = 15_000;
/** What a stopping process keeps of its stop's time to settle its turns. */
const STOP_SETTLE_MS = 1_000;
/**
 * How long streamed deltas (an answer, a command's output) gather before
 * they are recorded: harnesses write in many small pieces, and each read
 * becomes a transaction, session events and a stream message. Streams
 * deliver no faster than the session feed polls (150 ms), so readers see
 * no difference.
 */
const STREAM_BATCH_MS = 100;
/** What a tool call answers when an earlier holder may have run it. */
const TAKEN_OVER_TOOL =
  "The machine running this turn stopped while this tool ran. It may or may not have completed: check its effects before trying again.";
/** What a tool call answers once its attempt ended. */
const ENDED_TOOL = "This turn already ended, so the tool did not run.";

/**
 * Drives claimed turns (ADR 0198): prepares an attempt, starts its runner
 * (or finds it again after a takeover), ingests its frames, answers its
 * host calls, delivers commands, and settles the turn. Every step that
 * matters to another replica is in Postgres; this process's memory holds
 * only the turns it claimed (ADR 0193, rule a).
 */
export class TurnEngine {
  private readonly leases: ReturnType<typeof startTurnLeaseRenewal>;
  /** Replica memory (a): turns this process claimed, by turn id. */
  private readonly local = new Map<string, LocalTurn>();
  private readonly native: NativeStateStore;
  private stopping = false;
  /** When a stop must be done by: an in-process drain ends in time to settle. */
  private stopDeadline: number | undefined;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      log: SessionLog;
      queue: TurnQueue;
      workerId: string;
      host: TurnEngineHost;
      inputText: InputText;
    },
  ) {
    this.native = new NativeStateStore(deps.db);
    this.leases = startTurnLeaseRenewal({
      renew: (held) => this.renew(held),
      onError: (error) =>
        console.warn("[catamorphic] Agent lease renewal failed", error),
    });
  }

  private async renew(
    held: readonly HeldTurnLease[],
  ): Promise<readonly RenewedTurnLease[]> {
    return this.deps.queue.renewHeld({
      workerId: this.deps.workerId,
      turns: held.map((turn) => ({
        turnId: turn.turnId,
        leaseToken: turn.leaseToken,
      })),
    });
  }

  /** Turns this process runs now. */
  runningTurnIds(): string[] {
    return [...this.local.keys()];
  }

  /**
   * Stop claiming. Turns whose runner survives this process (a sandbox on
   * a worker or a member's machine) are handed back at once for another
   * replica to reattach; the rest are interrupted and settle here, within
   * `timeoutMs`.
   */
  async stop(input: {
    timeoutMs: number;
    reattachable: (location: RunnerLocation) => boolean;
  }): Promise<void> {
    this.stopping = true;
    this.stopDeadline = Date.now() + input.timeoutMs;
    const pending: Promise<void>[] = [];
    for (const local of this.local.values()) {
      const location = local.channel?.location;
      if (location && !local.finalizing && input.reattachable(location)) {
        local.handingBack = true;
        local.abort.abort();
        pending.push(
          this.deps.queue
            .handBack({
              turnId: local.claim.turn.id,
              leaseToken: local.claim.leaseToken,
            })
            .catch(() => {}),
        );
      } else {
        pending.push(
          this.requestInterrupt(local.claim.turn.id).catch(() => {}),
        );
        local.wake();
      }
    }
    await Promise.allSettled(pending);
    const deadline = Date.now() + input.timeoutMs;
    while (this.local.size > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    this.leases.stop();
  }

  private async requestInterrupt(turnId: string): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("agent_turns")
        .selectAll()
        .where("id", "=", turnId)
        .executeTakeFirst();
      if (!row) return;
      await this.deps.queue.enqueueCommand(trx, {
        turnId,
        attemptId: row.active_attempt_id,
        kind: "interrupt",
      });
    });
  }

  /**
   * Claim the session's next due turn (or one whose holder's lease lapsed)
   * and run it here. False when there was none to take.
   */
  async runNext(input: {
    sessionId: string;
    localNode?: { id: string; token: string };
  }): Promise<boolean> {
    if (this.stopping) return false;
    const claim = await this.deps.queue.claim({
      workerId: this.deps.workerId,
      sessionId: input.sessionId,
      ...(input.localNode ? { localNode: input.localNode } : {}),
    });
    if (!claim) return false;
    await this.run(claim);
    return true;
  }

  private async run(claim: ClaimedTurn): Promise<void> {
    let wake = () => {};
    const local: LocalTurn = {
      claim,
      abort: new AbortController(),
      wake: () => wake(),
      handingBack: false,
      finalizing: false,
      results: new Map(),
      resultsSentAt: 0,
    };
    const nextWake = () =>
      new Promise<void>((resolve) => {
        wake = () => {
          wake = () => {};
          resolve();
        };
      });
    local.waiter = nextWake();
    const rearm = () => {
      local.waiter = nextWake();
    };
    this.local.set(claim.turn.id, local);
    const release = this.leases.hold({
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      onLost: () => local.abort.abort(),
      onCancel: () => local.wake(),
      onCommands: () => local.wake(),
    });
    try {
      // A turn is its own operation: nothing of the drainer's (a workflow
      // run, a queue job) carries into it.
      await withTelemetryContext({ attributes: {}, reset: true }, () =>
        withSpan(
          {
            tracer,
            name: "agent.turn",
            attributes: {
              "catamorphic.agent.turn.id": claim.turn.id,
              "catamorphic.agent.session.id": claim.turn.sessionId,
              "catamorphic.agent.turn.recovered": claim.recovered,
            },
          },
          (span) => this.drive(local, rearm, span),
        ),
      );
    } catch (error) {
      // Losing the lease mid-step is losing the turn, not a failure of it.
      if (error instanceof TurnLeaseLostError) local.abort.abort();
      if (!local.abort.signal.aborted)
        console.warn("[catamorphic] A turn failed unexpectedly", error);
      if (!local.abort.signal.aborted)
        await this.failUnexpectedly(local, error).catch((settleError) =>
          console.warn(
            "[catamorphic] Could not settle a failed turn",
            settleError,
          ),
        );
    } finally {
      // A runner in this process cannot be reached by whoever holds the
      // turn next, so it stops with this holder.
      if (
        local.abort.signal.aborted &&
        local.channel?.location.kind === "in_process"
      )
        await local.channel.kill().catch(() => {});
      release();
      this.local.delete(claim.turn.id);
      this.deps.host.released?.({
        sessionId: claim.turn.sessionId,
        turnId: claim.turn.id,
      });
    }
  }

  // -------------------------------------------------------------------------

  private async drive(
    local: LocalTurn,
    rearm: () => void,
    span?: Span,
  ): Promise<void> {
    const { db } = this.deps;
    const turnId = local.claim.turn.id;
    const session = await db
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", local.claim.turn.sessionId)
      .executeTakeFirstOrThrow();
    const identity = await this.deps.host.owner(session);
    if (!identity) {
      // The owner cannot act now (disabled, unknown): the turn waits.
      await this.deps.queue.handBack({
        turnId,
        leaseToken: local.claim.leaseToken,
      });
      return;
    }
    if (span)
      setSpanCorrelation({
        span,
        attributes: {
          "catamorphic.tenant.id": identity.tenantId,
          "user.id": identity.externalUserId,
          "catamorphic.project.id": session.project_id,
          "catamorphic.agent.session.id": session.id,
          "catamorphic.agent.turn.id": turnId,
        },
      });
    let turn = await this.loadTurn(turnId);
    // Taken over while it restarted for a steer: the attempt it superseded
    // may still be storing what it wrote, on a sandbox that outlived its
    // holder. The next attempt resumes that thread, so it comes first.
    if (local.claim.recovered && turn.status === "preparing")
      await this.drainSuperseded(local, { identity, session, turn });
    for (;;) {
      if (local.abort.signal.aborted) return;
      if (turn.status === "finalizing") {
        local.finalizing = true;
        const attempt = await this.activeAttempt(turn);
        const cursor = await this.reattachEnded(local, {
          identity,
          session,
          turn,
          attempt,
        });
        await this.finalize(local, {
          identity,
          session,
          turn,
          attempt,
          completion: { status: attemptOutcome(attempt) },
          ...(cursor === undefined ? {} : { cursor }),
        });
        return;
      }
      if (turn.status === "preparing") {
        const outcome = await this.prepareAndLaunch(local, {
          identity,
          session,
          turn,
        });
        if (outcome.kind === "settled") return;
        turn = outcome.turn;
      }
      if (turn.status === "running" || turn.status === "waiting") {
        const attempt = await this.activeAttempt(turn);
        const result = await this.pump(local, rearm, {
          identity,
          session,
          turn,
          attempt,
        });
        if (result.kind === "aborted") {
          // Lost or handed back: a sandbox runner stays for whoever holds
          // the turn next; one in this process cannot be reached by anyone
          // else, so it stops with this holder.
          if (result.channel?.location.kind === "in_process")
            await result.channel.kill().catch(() => {});
          return;
        }
        if (result.kind === "lost") {
          await this.lose(local, {
            identity,
            session,
            turn: result.turn,
            attempt: result.attempt,
            reason: result.reason,
          });
          return;
        }
        if (result.kind === "restart") {
          turn = result.turn;
          continue;
        }
        const retried = await this.retryFailure(local, rearm, {
          identity,
          session,
          turn: result.turn,
          attempt: result.attempt,
          completion: result.completion,
          ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
        });
        if (retried.kind === "settled") return;
        if (retried.kind === "retry") {
          turn = retried.turn;
          continue;
        }
        await this.finalize(local, {
          identity,
          session,
          turn: result.turn,
          attempt: result.attempt,
          completion: result.completion,
          ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
        });
        return;
      }
      // Settled or queued meanwhile (a close, a cancel): nothing to run.
      return;
    }
  }

  /**
   * One more attempt before a failed turn settles, when its host knows the
   * failure is passing (ADR 0227): a sign-in the harness could not refresh
   * in time, though it still can be. Only for a failure nothing ran in that
   * the engine does not retry by itself (rate limits and outages queue
   * their own), and once per turn: never after an earlier attempt of it
   * failed. The turn stays active meanwhile and says so on its activity
   * line; the failed attempt keeps its error. A stop during the pause ends
   * the turn interrupted.
   */
  private async retryFailure(
    local: LocalTurn,
    rearm: () => void,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
      completion: {
        status: "completed" | "failed" | "interrupted";
        error?: TurnError;
      };
      cursor?: number;
    },
  ): Promise<
    { kind: "no" } | { kind: "settled" } | { kind: "retry"; turn: Turn }
  > {
    const { db, log } = this.deps;
    const error = ctx.completion.error;
    if (
      ctx.completion.status !== "failed" ||
      error?.retrySafe !== true ||
      error.kind === "rate_limit" ||
      error.kind === "unavailable" ||
      !this.deps.host.retryFailure ||
      local.abort.signal.aborted ||
      this.stopping
    )
      return { kind: "no" };
    const earlier = await db
      .selectFrom("agent_turn_attempts")
      .select("id")
      .where("turn_id", "=", ctx.turn.id)
      .where("id", "!=", ctx.attempt.id)
      .where("status", "=", "failed")
      .limit(1)
      .executeTakeFirst();
    if (earlier) return { kind: "no" };
    const retry = await this.deps.host
      .retryFailure({
        identity: ctx.identity,
        session: ctx.session,
        turn: ctx.turn,
        error,
      })
      .catch((cause: unknown) => {
        console.warn("[catamorphic] Could not judge a failed attempt", cause);
        return undefined;
      });
    if (!retry || local.abort.signal.aborted) return { kind: "no" };
    const now = new Date().toISOString();
    const failed: Attempt = {
      ...ctx.attempt,
      status: "failed",
      completedAt: now,
      error,
    };
    const waiting: Turn = {
      ...ctx.turn,
      status: "preparing",
      activity: retry.activity,
      activityAt: now,
      updatedAt: now,
    };
    let stopped = false;
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      await log.lock(trx, ctx.turn.sessionId);
      const current = await trx
        .selectFrom("agent_turns")
        .select("cancellation_requested_at")
        .where("id", "=", ctx.turn.id)
        .executeTakeFirstOrThrow();
      // A person's stop stands: the turn ends as it failed.
      if (current.cancellation_requested_at !== null) {
        stopped = true;
        return;
      }
      await log.append(trx, {
        sessionId: ctx.turn.sessionId,
        events: [
          { type: "attempt.changed", attempt: failed },
          { type: "turn.changed", turn: waiting },
        ],
      });
    });
    if (stopped) return { kind: "no" };
    // The failed harness winds down first, storing what it wrote.
    if (local.channel && ctx.cursor !== undefined)
      await this.drainRunner(
        local,
        { ...ctx, turn: waiting, attempt: failed },
        local.channel,
        ctx.cursor,
      );
    local.results.clear();
    const due = Date.now() + hostRetryDelay(retry.afterMs);
    for (;;) {
      if (local.abort.signal.aborted) return { kind: "settled" };
      const current = await this.loadTurn(ctx.turn.id);
      // A person's stop, or this process stopping, ends it here.
      if (current.cancellationRequested || this.stopping) {
        await this.finalize(local, {
          identity: ctx.identity,
          session: ctx.session,
          turn: current,
          attempt: failed,
          completion: { status: "interrupted" },
        });
        return { kind: "settled" };
      }
      const left = due - Date.now();
      if (left <= 0) return { kind: "retry", turn: current };
      // A stop wakes the pause early, and so do commands, which wait for
      // the next attempt; a lost lease ends it.
      await abortableSleep(left, local.abort.signal, local.waiter);
      rearm();
    }
  }

  private async loadTurn(turnId: string): Promise<Turn> {
    const row = await this.deps.db
      .selectFrom("agent_turns")
      .selectAll()
      .where("id", "=", turnId)
      .executeTakeFirstOrThrow();
    return turnFromRow(row);
  }

  private async activeAttempt(
    turn: Turn,
  ): Promise<
    Attempt & { runner: RunnerState | null; providerStartedAt: Date | null }
  > {
    const row = turn.activeAttemptId
      ? await this.deps.db
          .selectFrom("agent_turn_attempts")
          .selectAll()
          .where("id", "=", turn.activeAttemptId)
          .executeTakeFirst()
      : undefined;
    if (!row) throw new Error(`Turn ${turn.id} has no attempt`);
    return withRunner(row);
  }

  /**
   * The sandbox runners of superseded attempts nobody saw end, oldest
   * first, reattached and answered until they exit (see reattachEnded and
   * drainRunner).
   */
  private async drainSuperseded(
    local: LocalTurn,
    ctx: { identity: Identity; session: SessionRow; turn: Turn },
  ): Promise<void> {
    const rows = await this.deps.db
      .selectFrom("agent_turn_attempts")
      .selectAll()
      .where("turn_id", "=", ctx.turn.id)
      .where("status", "=", "superseded")
      .orderBy("ordinal")
      .execute();
    for (const row of rows) {
      if (local.abort.signal.aborted) return;
      const attempt = withRunner(row);
      const cursor = await this.reattachEnded(local, { ...ctx, attempt });
      if (cursor === undefined || !local.channel) continue;
      await this.drainRunner(local, { ...ctx, attempt }, local.channel, cursor);
      local.results.clear();
    }
  }

  /** Why the next attempt of this turn runs. */
  private async nextReason(
    turn: Turn,
  ): Promise<{ reason: AttemptReason; previous: Attempt | null }> {
    const row = await this.deps.db
      .selectFrom("agent_turn_attempts")
      .selectAll()
      .where("turn_id", "=", turn.id)
      .orderBy("ordinal", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return { reason: "initial", previous: null };
    const previous = attemptFromRow(row);
    if (previous.status === "preparing")
      return { reason: previous.reason, previous };
    if (previous.status === "superseded")
      return { reason: "steer_restart", previous };
    if (previous.status === "lost") return { reason: "recovery", previous };
    return { reason: "retry", previous };
  }

  // -------------------------------------------------------------------------
  // Preparing and starting an attempt

  private async prepareAndLaunch(
    local: LocalTurn,
    ctx: { identity: Identity; session: SessionRow; turn: Turn },
  ): Promise<{ kind: "settled" } | { kind: "running"; turn: Turn }> {
    const { db, log } = this.deps;
    const now = () => new Date().toISOString();
    const { reason, previous } = await this.nextReason(ctx.turn);
    // A preparation that died is prepared again under the same attempt:
    // the harness was never asked to start.
    let attempt: Attempt =
      previous && previous.status === "preparing"
        ? previous
        : {
            id: randomUUID(),
            turnId: ctx.turn.id,
            sessionId: ctx.turn.sessionId,
            ordinal: (previous?.ordinal ?? 0) + 1,
            reason,
            status: "preparing",
            providerThreadId: null,
            nativeTurnRef: null,
            error: null,
            createdAt: now(),
            startedAt: now(),
            completedAt: null,
          };
    let turn = ctx.turn;
    if (attempt !== previous) {
      turn = {
        ...turn,
        activeAttemptId: attempt.id,
        attemptCount: turn.attemptCount + 1,
        updatedAt: now(),
      };
      await db.transaction().execute(async (trx) => {
        await this.assertOwned(local, trx);
        await log.append(trx, {
          sessionId: turn.sessionId,
          events: [
            { type: "attempt.changed", attempt },
            { type: "turn.changed", turn },
          ],
        });
      });
    }
    const harness = await this.deps.host.harnessOf({
      identity: ctx.identity,
      session: ctx.session,
    });
    // The conversation stays on the harness its first turn bound (ADR
    // 0214). Its agent reaches another only by a change outside the chat
    // (a project agent's definition, say): the turn fails rather than
    // hand the conversation to that harness. An agent that cannot run says
    // why first, and binds nothing. Read now, not with the drive's
    // session: an earlier attempt of this turn may have bound it.
    const { harness: bound } = await db
      .selectFrom("agent_sessions")
      .select("harness")
      .where("id", "=", turn.sessionId)
      .executeTakeFirstOrThrow();
    const refusal =
      harness.unavailable ??
      (bound !== null && bound !== harness.harness
        ? `This chat runs on ${bound}, and its agent now runs on ${harness.harness}. Start a new chat to use it.`
        : null);
    if (refusal !== null) {
      await this.settle(local, {
        identity: ctx.identity,
        session: ctx.session,
        turn,
        attempt: { ...attempt, status: "failed", completedAt: now() },
        status: "failed",
        error: { message: refusal },
        outcome: turn.outcome ?? { changedFiles: [] },
        checkpointAfter: null,
      });
      return { kind: "settled" };
    }
    const binding = await this.bindThread({
      turn,
      attempt,
      harness: harness.harness,
      bound: bound !== null,
      local,
    });
    turn = binding.turn;
    attempt = binding.attempt;

    const prepared = await this.deps.host.prepare({
      identity: ctx.identity,
      session: ctx.session,
      turn,
      attempt,
      signal: local.abort.signal,
    });
    if (local.abort.signal.aborted) return { kind: "settled" };
    const current = await this.loadTurn(turn.id);
    if (current.cancellationRequested) {
      await this.settle(local, {
        identity: ctx.identity,
        session: ctx.session,
        turn: current,
        attempt: { ...attempt, status: "interrupted", completedAt: now() },
        status: "interrupted",
        outcome: { changedFiles: [] },
        checkpointAfter: null,
      });
      return { kind: "settled" };
    }
    const inputItem = turn.inputItemId
      ? await db
          .selectFrom("agent_items")
          .select("payload")
          .where("id", "=", turn.inputItemId)
          .executeTakeFirst()
      : undefined;
    // What was delivered without waking the agent reaches its next turn.
    const riders =
      reason === "initial"
        ? await this.riders({
            session: ctx.session,
            turn,
            ownerOnly: prepared.ownerOnly === true,
          })
        : [];
    const { input, steered } = await this.attemptInput({
      turn,
      attempt,
      reason,
      inputItem: inputItem ? itemFromRow(inputItem) : null,
      riders,
      handoff:
        [binding.handoff, ...(prepared.notes ?? [])]
          .filter(Boolean)
          .join("\n\n") || null,
    });
    if (
      prepared.checkpointBefore !== undefined &&
      turn.checkpoint.before === null
    )
      turn = {
        ...turn,
        checkpoint: { ...turn.checkpoint, before: prepared.checkpointBefore },
      };
    const start: AttemptStart = {
      ...prepared.start,
      protocol: RUNNER_PROTOCOL_VERSION,
      sessionId: turn.sessionId,
      projectId: ctx.session.project_id,
      turnId: turn.id,
      attemptId: attempt.id,
      reason,
      thread: binding.binding,
      input,
    };
    const channel = await prepared.launch();
    local.channel = channel;
    local.mask = new SecretMask(prepared.secretValues ?? {});
    const runner: RunnerState = {
      location: channel.location,
      cursor: 0,
      hello: null,
      calls: {},
      restartWith: [],
      // Exactly what the prompt carries: a steer arriving after it was read
      // is sent to the new attempt instead.
      consumed: steered,
      interruptSentAt: null,
      ...(prepared.ownerOnly ? { ownerOnly: true } : {}),
      ...(prepared.ownerOnly && prepared.ownerOnlyBecause
        ? { ownerOnlyBecause: prepared.ownerOnlyBecause }
        : {}),
    };
    const running: Turn = {
      ...turn,
      status: "running",
      activity: "Working",
      activityAt: now(),
      updatedAt: now(),
    };
    attempt = { ...attempt, status: "running" };
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      await trx
        .updateTable("agent_turn_attempts")
        .set({
          runner: runner as unknown as Json,
          provider_started_at: new Date(),
        })
        .where("id", "=", attempt.id)
        .execute();
      await log.append(trx, {
        sessionId: turn.sessionId,
        events: [
          { type: "attempt.changed", attempt },
          { type: "turn.changed", turn: running },
          // Read with this turn, and its own from now on: a retry or a
          // handoff of the turn carries them too.
          ...riders.map(
            (item): SessionEvent => ({
              type: "item.changed",
              item: {
                ...item,
                turnId: turn.id,
                status: "completed",
                updatedAt: now(),
              },
            }),
          ),
        ],
      });
    });
    await channel.send([
      { id: `start:${attempt.id}`, command: { kind: "start", attempt: start } },
    ]);
    return { kind: "running", turn: running };
  }

  /**
   * Inputs delivered `message_only` that no turn took in yet (ADR 0217),
   * oldest first. A turn on its owner's sign-in or files takes only what
   * the owner wrote (ADR 0199); the rest waits for one that may.
   */
  private async riders(input: {
    session: SessionRow;
    turn: Turn;
    ownerOnly: boolean;
  }): Promise<InputItem[]> {
    const rows = await this.deps.db
      .selectFrom("agent_items")
      .select("payload")
      .where("session_id", "=", input.turn.sessionId)
      .where("kind", "in", [...INPUT_ITEM_KINDS])
      .where("dispatch", "=", "message_only")
      .where("status", "=", "in_progress")
      .where("turn_id", "is", null)
      .orderBy("position")
      .limit(50)
      .execute();
    const items = rows.map((row) => itemFromRow(row)).filter(isInputItem);
    if (!input.ownerOnly) return items;
    const admitted: InputItem[] = [];
    for (const item of items)
      if (
        await this.deps.host.authoredByOwner({ session: input.session, item })
      )
        admitted.push(item);
    return admitted;
  }

  /**
   * The input the harness receives (ADR 0217): what was delivered without
   * waking the agent since it last worked, the turn's own input, and the
   * inputs that joined the turn while it waited; a handoff before them.
   */
  private async attemptInput(input: {
    turn: Turn;
    attempt: Attempt;
    reason: AttemptReason;
    inputItem: Item | null;
    riders: InputItem[];
    handoff: string | null;
  }): Promise<{ input: AttemptStart["input"]; steered: string[] }> {
    const others = (
      await this.deps.db
        .selectFrom("agent_items")
        .select("payload")
        .where("turn_id", "=", input.turn.id)
        .where("kind", "in", [...INPUT_ITEM_KINDS])
        .$if(input.turn.inputItemId !== null, (query) =>
          query.where("id", "!=", input.turn.inputItemId ?? ""),
        )
        .orderBy("position")
        .execute()
    )
      .map((row) => itemFromRow(row))
      .filter(isInputItem);
    // What an earlier attempt took in is already on the resumed thread.
    const taken =
      input.reason === "steer_restart"
        ? new Set(
            (
              await this.deps.db
                .selectFrom("agent_turn_attempts")
                .select("runner")
                .where("turn_id", "=", input.turn.id)
                .execute()
            ).flatMap(
              (row) =>
                (row.runner as unknown as RunnerState | null)?.consumed ?? [],
            ),
          )
        : new Set<string>();
    const steeredItems =
      input.reason === "steer_restart"
        ? others.filter((item) => !taken.has(item.id))
        : [];
    // Inputs that joined the turn while it waited (and, on a retry, what
    // its first attempt read) are part of its prompt; ones steered into a
    // running attempt reached it on their own.
    const joined =
      input.reason === "steer_restart"
        ? []
        : others.filter((item) => item.dispatch !== "steer");
    const steerTexts = steeredItems.map((item) => this.deps.inputText(item));
    const base =
      input.inputItem && isInputItem(input.inputItem) ? input.inputItem : null;
    const inputs = [...input.riders, ...(base ? [base] : []), ...joined];
    const attachments: AgentAttachment[] = (
      input.reason === "steer_restart" && steerTexts.length > 0
        ? steeredItems
        : inputs
    ).flatMap((item) =>
      item.kind === "task_notification" ? [] : item.attachments,
    );
    const body =
      input.reason === "steer_restart" && steerTexts.length > 0
        ? `Your previous attempt at this turn was stopped so you can take in these messages that arrived while you worked:\n\n${steerTexts.join("\n\n")}`
        : [
            ...input.riders.map((item) => this.deps.inputText(item)),
            // A continuation (or a turn whose input is gone) carries on.
            base ? this.deps.inputText(base) : CONTINUATION_PROMPT,
            ...joined.map((item) => this.deps.inputText(item)),
          ].join("\n\n");
    const full = input.handoff ? `${input.handoff}\n\n---\n\n${body}` : body;
    const carried =
      input.reason === "steer_restart"
        ? steeredItems
        : [...input.riders, ...joined];
    return {
      input: {
        itemId: input.inputItem?.id ?? derivedId(input.attempt.id, "input"),
        text: full,
        attachments,
      },
      // Exactly what the prompt carries: a steer for one of these is not
      // delivered again.
      steered:
        input.reason === "steer_restart" && steerTexts.length === 0
          ? []
          : carried.map((item) => item.id),
    };
  }

  /**
   * The native thread this attempt runs on (ADR 0198): the session's
   * thread for this harness, resumed (or restored from stored state); a
   * fork of a source thread for a forked session's first turn; else a fresh
   * one, told what it missed by a recorded handoff. The first binds the
   * session to the harness (ADR 0214).
   */
  private async bindThread(input: {
    turn: Turn;
    attempt: Attempt;
    harness: string;
    /** The session is already bound to this harness. */
    bound: boolean;
    local: LocalTurn;
  }): Promise<{
    binding: ThreadBinding;
    turn: Turn;
    attempt: Attempt;
    handoff: string | null;
  }> {
    const { db, log } = this.deps;
    const now = new Date().toISOString();
    const rows = await db
      .selectFrom("agent_provider_threads")
      .selectAll()
      .where("session_id", "=", input.turn.sessionId)
      .orderBy("updated_at", "desc")
      .execute();
    const sameHarness = rows.find(
      (row) => row.harness === input.harness && row.status === "active",
    );
    let thread: ProviderThread;
    let binding: ThreadBinding;
    let handoffFrom: number | null = null;
    let strategy: "delta" | "full" = "full";
    if (sameHarness?.fork_source && !sameHarness.native_ref) {
      const fork = sameHarness.fork_source as unknown as {
        source: NativeRef;
        throughTurnRef?: NativeRef;
        statePath?: string;
      };
      thread = providerThreadFromRow(sameHarness);
      binding = {
        mode: "fork",
        providerThreadId: thread.id,
        source: fork.source,
        ...(fork.throughTurnRef ? { throughTurnRef: fork.throughTurnRef } : {}),
        ...(fork.statePath ? { statePath: fork.statePath } : {}),
      };
    } else if (sameHarness?.native_ref) {
      thread = providerThreadFromRow(sameHarness);
      const nativeRef = sameHarness.native_ref as unknown as NativeRef;
      // Where the thread's history ends, for a harness kept warm since.
      const last = await db
        .selectFrom("agent_turn_attempts")
        .select("native_turn_ref")
        .where("provider_thread_id", "=", thread.id)
        .where("native_turn_ref", "is not", null)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      const lastTurnRef = last?.native_turn_ref as unknown as NativeRef | null;
      binding = {
        mode: (await this.native.has({ threadId: thread.id }))
          ? "restore"
          : "resume",
        providerThreadId: thread.id,
        nativeRef,
        ...(lastTurnRef ? { lastTurnRef } : {}),
        ...(sameHarness.state_path
          ? { statePath: sameHarness.state_path }
          : {}),
      };
      if (
        thread.lastTurnOrdinal !== null &&
        thread.lastTurnOrdinal < input.turn.ordinal - 1
      ) {
        handoffFrom = thread.lastTurnOrdinal + 1;
        strategy = "delta";
      }
    } else {
      thread = sameHarness
        ? providerThreadFromRow(sameHarness)
        : {
            id: randomUUID(),
            sessionId: input.turn.sessionId,
            harness: input.harness,
            nativeRef: null,
            status: "active",
            lastTurnOrdinal: null,
            portable: false,
            createdAt: now,
            updatedAt: now,
          };
      binding = { mode: "fresh", providerThreadId: thread.id };
      if (input.turn.ordinal > 1) handoffFrom = 1;
    }
    const handoff =
      handoffFrom !== null
        ? await buildContextHandoff({
            db,
            sessionId: input.turn.sessionId,
            fromOrdinal: handoffFrom,
            toOrdinal: input.turn.ordinal - 1,
            strategy,
          })
        : null;
    const turn: Turn = {
      ...input.turn,
      providerThreadId: thread.id,
      updatedAt: now,
    };
    const attempt: Attempt = { ...input.attempt, providerThreadId: thread.id };
    const events: SessionEvent[] = [
      {
        type: "provider_thread.changed",
        thread: { ...thread, updatedAt: now },
      },
      { type: "attempt.changed", attempt },
      { type: "turn.changed", turn },
    ];
    if (!input.bound)
      events.push({
        type: "session.changed",
        session: { harness: input.harness, updatedAt: now },
      });
    if (handoff)
      events.push({
        type: "item.added",
        item: {
          id: derivedId(attempt.id, "handoff"),
          sessionId: turn.sessionId,
          turnId: turn.id,
          attemptId: attempt.id,
          parentItemId: null,
          position: 0,
          status: "completed",
          nativeRef: null,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          endedAt: now,
          kind: "context_handoff",
          strategy: handoff.strategy,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: thread.id,
          coveredTurnOrdinals: handoff.coveredTurnOrdinals,
          text: handoff.text,
        },
      });
    // Other harnesses' threads stay: returning to one later resumes it.
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(input.local, trx);
      const existing = handoff
        ? await trx
            .selectFrom("agent_items")
            .select("id")
            .where("id", "=", derivedId(attempt.id, "handoff"))
            .executeTakeFirst()
        : undefined;
      await log.append(trx, {
        sessionId: turn.sessionId,
        events: existing
          ? events.filter((event) => event.type !== "item.added")
          : events,
      });
    });
    return { binding, turn, attempt, handoff: handoff?.text ?? null };
  }

  // -------------------------------------------------------------------------
  // Pumping a runner

  private async pump(
    local: LocalTurn,
    rearm: () => void,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt & { runner: RunnerState | null };
    },
  ): Promise<
    | { kind: "aborted"; channel: RunnerChannel | undefined }
    | { kind: "lost"; turn: Turn; attempt: Attempt; reason: string }
    | { kind: "restart"; turn: Turn }
    | {
        kind: "completed";
        turn: Turn;
        attempt: Attempt;
        completion: {
          status: "completed" | "failed" | "interrupted";
          error?: TurnError;
        };
        /** How far the runner, left up while its harness winds down, was read. */
        cursor?: number;
      }
  > {
    const { db, log, queue } = this.deps;
    let runner = ctx.attempt.runner;
    let turn = ctx.turn;
    let attempt: Attempt = ctx.attempt;
    if (!runner)
      return {
        kind: "lost",
        turn,
        attempt,
        reason: "The agent's runner never started.",
      };
    let channel = local.channel;
    if (!channel) {
      channel =
        runner.location.kind === "in_process"
          ? reattachInProcessRunner(runner.location)
          : await this.deps.host.reattach({
              identity: ctx.identity,
              session: ctx.session,
              location: runner.location,
            });
      if (!channel)
        return {
          kind: "lost",
          turn,
          attempt,
          reason: "The machine running this turn stopped before it finished.",
        };
      local.channel = channel;
      await this.maskTakenOver(local, ctx);
      // A holder can stop between recording the runner and sending its
      // start. A runner that never said hello never got it: stop it and
      // prepare the same attempt again, as for a preparation that died.
      if (runner.hello === null && runner.cursor === 0) {
        const deadline = Date.now() + START_GRACE_MS;
        let heard = false;
        while (!heard && Date.now() < deadline) {
          if (local.abort.signal.aborted) return { kind: "aborted", channel };
          const peek = await channel.read({ cursor: 0, waitMs: 1_000 });
          heard = peek.frames.length > 0 || peek.exited;
        }
        if (!heard) {
          await channel.kill().catch(() => {});
          local.channel = undefined;
          const preparing: Turn = {
            ...turn,
            status: "preparing",
            updatedAt: new Date().toISOString(),
          };
          await db.transaction().execute(async (trx) => {
            await this.assertOwned(local, trx);
            await trx
              .updateTable("agent_turn_attempts")
              .set({ runner: null, provider_started_at: null })
              .where("id", "=", attempt.id)
              .execute();
            await log.append(trx, {
              sessionId: turn.sessionId,
              events: [
                {
                  type: "attempt.changed",
                  attempt: { ...attempt, status: "preparing" },
                },
                { type: "turn.changed", turn: preparing },
              ],
            });
          });
          return { kind: "restart", turn: preparing };
        }
      }
      // Answer again what the previous holder took and did not answer.
      await this.answerCalls(
        local,
        ctx,
        channel,
        Object.entries(runner.calls),
        TAKEN_OVER_TOOL,
      );
    }
    let thread = await this.loadThread(attempt.providerThreadId);
    let completion:
      | {
          status: "completed" | "failed" | "interrupted";
          error?: TurnError;
          ref?: NativeRef;
        }
      | undefined;
    let interruptAt = runner.interruptSentAt
      ? Date.parse(runner.interruptSentAt)
      : null;
    const agentId = ctx.session.agent_id;

    const sendCommands = async () => {
      const commands = await queue.openCommands({ turnId: turn.id });
      if (commands.length === 0) return;
      const frames: RunnerCommandFrame[] = [];
      const moot: string[] = [];
      for (const command of commands) {
        const frame = await this.commandFrame(command, {
          attemptId: attempt.id,
          consumed: runner?.consumed ?? [],
        });
        if (frame) frames.push(frame);
        else moot.push(command.id);
      }
      // A command with nobody left to reach (input this attempt already
      // has, a request of an earlier attempt) is dropped, never resent.
      if (moot.length > 0)
        await queue.markCommands({ ids: moot, status: "dropped" });
      if (frames.length === 0) return;
      await channel?.send(frames);
      await queue.markCommands({
        ids: commands
          .filter(
            (command) =>
              command.status === "pending" && !moot.includes(command.id),
          )
          .map((command) => command.id),
        status: "sent",
      });
      if (
        commands.some((command) => command.kind === "interrupt") &&
        interruptAt === null
      )
        interruptAt = Date.now();
    };
    await sendCommands();

    let commandsInFlight: Promise<void> | undefined;
    for (;;) {
      if (local.abort.signal.aborted) return { kind: "aborted", channel };
      await this.resendResults(local, attempt.id, channel);
      if (!commandsInFlight)
        commandsInFlight = local.waiter?.then(async () => {
          rearm();
          commandsInFlight = undefined;
          if (!local.abort.signal.aborted)
            await sendCommands().catch((error) =>
              console.warn(
                "[catamorphic] Could not deliver turn commands",
                error,
              ),
            );
        });
      let read = await channel.read({
        cursor: runner.cursor,
        waitMs: runner.location.kind === "in_process" ? 500 : 2_000,
      });
      if (local.abort.signal.aborted) return { kind: "aborted", channel };
      if (onlyDeltas(read)) {
        // Streamed text or output: record what arrives over the next
        // moment as one batch, which the ingest folds into one append per
        // item.
        await abortableSleep(STREAM_BATCH_MS, local.abort.signal);
        if (local.abort.signal.aborted) return { kind: "aborted", channel };
        const more = await channel.read({ cursor: read.cursor, waitMs: 0 });
        read = {
          frames: [...read.frames, ...more.frames],
          diagnostics: [...read.diagnostics, ...more.diagnostics],
          cursor: more.cursor,
          exited: more.exited,
        };
      }
      for (const line of read.diagnostics)
        console.warn(
          `[catamorphic] agent runner (turn ${turn.id}): ${local.mask?.text(line) ?? line}`,
        );
      if (read.frames.length > 0 || read.cursor !== runner.cursor) {
        const outcome = await this.applyFrames(local, {
          ...ctx,
          turn,
          attempt,
          thread,
          runner,
          frames: read.frames,
          cursor: read.cursor,
          agentId,
        });
        turn = outcome.turn;
        attempt = outcome.attempt;
        thread = outcome.thread;
        runner = outcome.runner;
        if (outcome.completion) completion = outcome.completion;
        if (outcome.appended.length > 0)
          await this.sendResults(
            local,
            attempt.id,
            channel,
            outcome.appended.map((callId) => ({ callId, result: null })),
          );
        if (outcome.calls.length > 0)
          void this.answerCalls(
            local,
            ctx,
            channel,
            outcome.calls,
            outcome.completion ? ENDED_TOOL : undefined,
          ).catch((error) =>
            console.warn("[catamorphic] A host call failed", error),
          );
        if (outcome.refusedSteers.length > 0) {
          runner = {
            ...runner,
            restartWith: [...runner.restartWith, ...outcome.refusedSteers],
          };
          await this.saveRunner(local, attempt.id, runner);
          await this.requestInterrupt(turn.id);
          local.wake();
        }
      }
      if (completion) {
        if (
          completion.status === "interrupted" &&
          runner.restartWith.length > 0
        ) {
          // Steered input the harness could not take: a new attempt of the
          // same turn, on the same native thread, with that input.
          const superseded: Attempt = {
            ...attempt,
            status: "superseded",
            completedAt: new Date().toISOString(),
          };
          const preparing: Turn = {
            ...turn,
            status: "preparing",
            activity: "Taking in your message",
            updatedAt: new Date().toISOString(),
          };
          let stopped = false;
          await db.transaction().execute(async (trx) => {
            await this.assertOwned(local, trx);
            // A person's stop (or send now) meanwhile ends the turn instead:
            // its steered messages then run as turns of their own.
            await log.lock(trx, turn.sessionId);
            const current = await trx
              .selectFrom("agent_turns")
              .select("cancellation_requested_at")
              .where("id", "=", turn.id)
              .executeTakeFirstOrThrow();
            if (current.cancellation_requested_at !== null) {
              stopped = true;
              return;
            }
            // The new attempt's prompt carries every steered message, so
            // no steer is sent again, and the interrupt has done its work.
            await queue.markCommands({
              ids: (
                await queue.openCommands({ turnId: turn.id, executor: trx })
              )
                .filter(
                  (command) =>
                    command.kind === "interrupt" || command.kind === "steer",
                )
                .map((command) => command.id),
              status: "dropped",
              executor: trx,
            });
            await log.append(trx, {
              sessionId: turn.sessionId,
              events: [
                { type: "attempt.changed", attempt: superseded },
                {
                  type: "turn.changed",
                  turn: { ...preparing, cancellationRequested: false },
                },
              ],
            });
          });
          if (!stopped) {
            // The next attempt resumes this native thread: everything the
            // harness stores on its way out comes first.
            await this.drainRunner(
              local,
              { ...ctx, turn, attempt },
              channel,
              runner.cursor,
            );
            if (local.abort.signal.aborted) return { kind: "aborted", channel };
            local.results.clear();
            return {
              kind: "restart",
              turn: { ...preparing, cancellationRequested: false },
            };
          }
        }
        // The runner stays up while the turn finalizes (see drainRunner).
        return {
          kind: "completed",
          turn,
          attempt,
          completion,
          cursor: runner.cursor,
        };
      }
      if (read.exited)
        return {
          kind: "lost",
          turn,
          attempt,
          reason:
            "The agent stopped unexpectedly before it finished this turn.",
        };
      if (
        interruptAt !== null &&
        Date.now() - interruptAt > INTERRUPT_GRACE_MS
      ) {
        // A harness that ignores its interrupt is stopped by force.
        await channel.kill();
        local.channel = undefined;
        return {
          kind: "completed",
          turn,
          attempt,
          completion: { status: "interrupted" },
        };
      }
    }
  }

  private async loadThread(id: string | null): Promise<ProviderThread> {
    if (!id) throw new Error("The attempt has no provider thread");
    const row = await this.deps.db
      .selectFrom("agent_provider_threads")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return providerThreadFromRow(row);
  }

  private async commandFrame(
    command: Awaited<ReturnType<TurnQueue["openCommands"]>>[number],
    attempt: { attemptId: string; consumed: readonly string[] },
  ): Promise<RunnerCommandFrame | null> {
    const { attemptId } = attempt;
    const id = `${command.kind}:${command.id}`;
    switch (command.kind) {
      case "interrupt":
        return { id, command: { kind: "interrupt" } };
      case "stop":
        return { id, command: { kind: "stop" } };
      case "steer": {
        const itemId =
          typeof command.payload.itemId === "string"
            ? command.payload.itemId
            : "";
        // Input the attempt started with, after a restart, is already in.
        if (attempt.consumed.includes(itemId)) return null;
        const row = await this.deps.db
          .selectFrom("agent_items")
          .select("payload")
          .where("id", "=", itemId)
          .executeTakeFirst();
        const item = row ? itemFromRow(row) : null;
        if (!item || !isInputItem(item)) return null;
        return {
          id,
          command: {
            kind: "steer",
            input: {
              itemId,
              text: this.deps.inputText(item),
              attachments:
                item.kind === "task_notification" ? [] : item.attachments,
            },
          },
        };
      }
      case "respond": {
        const requestKey =
          typeof command.payload.requestKey === "string"
            ? command.payload.requestKey
            : "";
        const response = command.payload.response as unknown as
          | RuntimeRequestResponse
          | undefined;
        if (!requestKey || !response) return null;
        // A response for an earlier attempt's request has nobody to reach.
        if (command.attemptId && command.attemptId !== attemptId) return null;
        return { id, command: { kind: "respond", requestKey, response } };
      }
      case "release": {
        const requestKey =
          typeof command.payload.requestKey === "string"
            ? command.payload.requestKey
            : "";
        const reason =
          typeof command.payload.reason === "string"
            ? command.payload.reason
            : "";
        if (
          !requestKey ||
          (command.attemptId && command.attemptId !== attemptId)
        )
          return null;
        return { id, command: { kind: "release", requestKey, reason } };
      }
    }
  }

  private async applyFrames(
    local: LocalTurn,
    input: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
      thread: ProviderThread;
      runner: RunnerState;
      frames: readonly RunnerFrame[];
      cursor: number;
      agentId: string | null;
    },
  ): Promise<{
    turn: Turn;
    attempt: Attempt;
    thread: ProviderThread;
    runner: RunnerState;
    calls: Array<[string, HostCall]>;
    /** Appends stored with these frames: their results are due now. */
    appended: string[];
    refusedSteers: string[];
    completion?: {
      status: "completed" | "failed" | "interrupted";
      error?: TurnError;
      ref?: NativeRef;
    };
  }> {
    const { db, log, queue } = this.deps;
    let policy: ApprovalPolicy | undefined;
    let refused = false;
    const opened: RuntimeRequest[] = [];
    // What a mask holds back changes only once this batch is recorded.
    const masking =
      local.mask && !local.mask.empty ? local.mask.begin() : undefined;
    const applied = await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      // The turn as it stands, under the lock: another replica may have
      // interrupted it, or a reply made it wait, since this holder read it.
      await log.lock(trx, input.turn.sessionId);
      const current = turnFromRow(
        await trx
          .selectFrom("agent_turns")
          .selectAll()
          .where("id", "=", input.turn.id)
          .executeTakeFirstOrThrow(),
      );
      let runner: RunnerState = { ...input.runner, cursor: input.cursor };
      const events = input.frames.flatMap((frame) =>
        frame.type === "event" ? [frame.event] : [],
      );
      const calls: Array<[string, HostCall]> = [];
      // Native state appends are output like events: stored with the
      // cursor that read them, so applied exactly once, and answered as
      // soon as this commits.
      const appends: Array<{
        callId: string;
        subpath?: string;
        entries: JsonValue[];
      }> = [];
      const delivered: string[] = [];
      const acked: string[] = [];
      const refusedSteers: string[] = [];
      for (const frame of input.frames) {
        if (frame.type === "hello")
          runner = {
            ...runner,
            hello: {
              harness: frame.harness.id,
              capabilities: frame.harness.capabilities,
            },
          };
        else if (frame.type === "call") {
          if (frame.callId in runner.calls) continue;
          const call = frame.call;
          // An append names no thread but its own: a fork writes its own.
          if (call.kind === "native_state.append") {
            appends.push({
              callId: frame.callId,
              ...(call.subpath ? { subpath: call.subpath } : {}),
              entries: call.entries,
            });
            runner = {
              ...runner,
              calls: { ...runner.calls, [frame.callId]: APPLIED_APPEND },
            };
            continue;
          }
          runner = {
            ...runner,
            calls: { ...runner.calls, [frame.callId]: call },
          };
          calls.push([frame.callId, call]);
        } else if (frame.type === "ack") {
          // Only queued turn commands are acknowledged in Postgres; the
          // engine's own (start, stop) are not rows, and an acknowledged
          // result lets its call go.
          const [kind, commandId] = splitCommandId(frame.commandId);
          if (
            kind === "result" &&
            commandId?.startsWith(`${input.attempt.id}:`)
          )
            delivered.push(commandId.slice(input.attempt.id.length + 1));
          if (commandId && QUEUED_COMMAND_KINDS.has(kind)) {
            acked.push(commandId);
            if (kind === "steer" && frame.error) refusedSteers.push(commandId);
          }
        }
      }
      const ingested = await ingestHarnessEvents({
        trx,
        state: {
          sessionId: input.turn.sessionId,
          turn: current,
          attempt: input.attempt,
          thread: input.thread,
          agentId: input.agentId,
        },
        events,
        now: new Date(),
        ...(masking ? { mask: masking } : {}),
      });
      if (ingested.consumed.length > 0)
        runner = {
          ...runner,
          consumed: [...(runner.consumed ?? []), ...ingested.consumed],
        };
      let turn = ingested.turn;
      const extra: SessionEvent[] = [];
      if (ingested.title)
        extra.push({
          type: "session.changed",
          session: { title: ingested.title },
        });
      if (ingested.usage) {
        turn = {
          ...turn,
          outcome: {
            changedFiles: turn.outcome?.changedFiles ?? [],
            ...turn.outcome,
            usage: ingested.usage,
          },
        };
        extra.push({ type: "turn.changed", turn });
      }
      let attempt = ingested.attempt;
      if (ingested.completed) {
        attempt = {
          ...attempt,
          status:
            ingested.completed.status === "completed"
              ? "completed"
              : ingested.completed.status === "interrupted"
                ? "interrupted"
                : "failed",
          ...(ingested.completed.ref
            ? { nativeTurnRef: ingested.completed.ref }
            : {}),
          error: ingested.completed.error ?? null,
          completedAt: new Date().toISOString(),
        };
        extra.push({ type: "attempt.changed", attempt });
      }
      // Approvals open under their chat's policy (ADR 0176): its approvers
      // and wait, or a refusal at once when no one can answer.
      const governed: SessionEvent[] = [];
      for (const event of ingested.events) {
        if (
          event.type !== "request.changed" ||
          event.request.kind !== "approval" ||
          event.request.status !== "pending" ||
          event.request.expiresAt !== null
        ) {
          governed.push(event);
          continue;
        }
        policy ??= await approvalPolicy(trx, input.turn.sessionId);
        const outcome = governApproval({
          request: event.request,
          policy,
          now: Date.now(),
        });
        governed.push({ type: "request.changed", request: outcome.request });
        if (outcome.refusal && event.request.runnerKey) {
          refused = true;
          await queue.enqueueCommand(trx, {
            turnId: input.turn.id,
            attemptId: input.attempt.id,
            kind: "respond",
            payload: {
              requestKey: event.request.runnerKey,
              response: {
                kind: "approval",
                decision: "denied",
                reason: outcome.refusal,
              },
            },
          });
        } else if (outcome.request.approvers.length > 0)
          opened.push(outcome.request);
      }
      // A refusal at once may leave nothing to wait on: the turn works on.
      if (refused && turn.status === "waiting") {
        const batch = governed.flatMap((event) =>
          event.type === "request.changed" ? [event.request] : [],
        );
        const waitsHere = batch.some(
          (request) => request.status === "pending" && request.blocking,
        );
        const waitsElsewhere =
          !waitsHere &&
          (await trx
            .selectFrom("agent_runtime_requests")
            .select("request_id")
            .where("session_id", "=", input.turn.sessionId)
            .where("turn_id", "=", turn.id)
            .where("status", "=", "pending")
            .where("blocking", "=", true)
            .$if(batch.length > 0, (query) =>
              query.where(
                "request_id",
                "not in",
                batch.map((request) => request.id),
              ),
            )
            .executeTakeFirst()) !== undefined;
        if (!waitsHere && !waitsElsewhere) {
          turn = {
            ...turn,
            status: "running",
            activity: "Working",
            activityAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          governed.push({ type: "turn.changed", turn });
        }
      }
      await log.append(trx, {
        sessionId: input.turn.sessionId,
        events: [...governed, ...extra],
      });
      if (ingested.statePath)
        await trx
          .updateTable("agent_provider_threads")
          .set({ state_path: ingested.statePath })
          .where("id", "=", ingested.thread.id)
          .execute();
      // After this batch's own thread events: the row turned portable
      // carries the native reference they set.
      for (const append of appends) {
        const turnedPortable = await this.native.append({
          threadId: ingested.thread.id,
          ...(append.subpath ? { subpath: append.subpath } : {}),
          entries: append.entries,
          executor: trx,
        });
        // The projection changes only through the log (ADR 0197).
        if (turnedPortable)
          await log.append(trx, {
            sessionId: input.turn.sessionId,
            events: [
              {
                type: "provider_thread.changed",
                thread: providerThreadFromRow(turnedPortable),
              },
            ],
          });
      }
      // A person's steer the harness refused restarts the attempt with it.
      // Anyone else's (a subagent's result) does not stop the work: it is
      // acknowledged here and runs as a turn of its own when this one ends.
      const restartSteers = await this.fromPeople(trx, refusedSteers);
      const acknowledged = acked.filter((id) => !restartSteers.includes(id));
      await queue.markCommands({
        ids: acknowledged,
        status: "acknowledged",
        executor: trx,
      });
      const appended = appends.map((append) => append.callId);
      await trx
        .updateTable("agent_turn_attempts")
        .set({
          runner: runnerWrite(
            runner,
            [
              ...calls,
              ...appended.map((callId): [string, HostCall] => [
                callId,
                APPLIED_APPEND,
              ]),
            ],
            appended,
          ),
        })
        .where("id", "=", attempt.id)
        .execute();
      for (const callId of delivered) {
        await this.forgetCall(trx, attempt.id, callId);
        local.results.delete(`result:${attempt.id}:${callId}`);
        const { [callId]: _done, ...rest } = runner.calls;
        runner = { ...runner, calls: rest };
      }
      return {
        turn,
        attempt,
        thread: ingested.thread,
        runner,
        calls,
        appended,
        refusedSteers: restartSteers,
        ...(ingested.completed ? { completion: ingested.completed } : {}),
      };
    });
    masking?.commit();
    if (refused) local.wake();
    if (opened.length > 0)
      await this.deps.host
        .approvalsOpened?.({ session: input.session, requests: opened })
        .catch((error) =>
          console.warn("[catamorphic] Could not tell approvers", error),
        );
    return applied;
  }

  private async saveRunner(
    local: LocalTurn,
    attemptId: string,
    runner: RunnerState,
  ): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      await trx
        .updateTable("agent_turn_attempts")
        .set({ runner: runnerWrite(runner) })
        .where("id", "=", attemptId)
        .execute();
    });
  }

  /**
   * Answer host calls. Native state is Postgres-only, so it is answered in
   * one transaction with forgetting the call: never applied twice. A host
   * tool runs outside it; one found taken after a takeover is answered
   * with the uncertainty, never run twice (ADR 0198), and one called after
   * its attempt ended never runs.
   */
  private async answerCalls(
    local: LocalTurn,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
    },
    channel: RunnerChannel,
    calls: ReadonlyArray<[string, HostCall]>,
    /**
     * Why a tool call is answered with this error instead of running: an
     * earlier holder may have run it, or its attempt ended.
     */
    refusal: string | undefined,
  ): Promise<void> {
    for (const [callId, call] of calls) {
      if (local.abort.signal.aborted) return;
      const threadId = await this.threadForCall(ctx.attempt, call);
      let result: JsonValue | undefined;
      let error: string | undefined;
      try {
        if (call.kind === "native_state.append") {
          await this.deps.db.transaction().execute(async (trx) => {
            await this.assertOwned(local, trx);
            // The session first, as ingest takes it before the thread and
            // the attempt.
            await this.deps.log.lock(trx, ctx.turn.sessionId);
            const row = await trx
              .selectFrom("agent_turn_attempts")
              .select("runner")
              .where("id", "=", ctx.attempt.id)
              .forUpdate()
              .executeTakeFirst();
            const recorded = row?.runner as unknown as RunnerState | null;
            if (recorded?.applied?.[callId]) return;
            const turnedPortable = await this.native.append({
              threadId,
              ...(call.subpath ? { subpath: call.subpath } : {}),
              entries: call.entries,
              executor: trx,
            });
            // The projection changes only through the log (ADR 0197).
            if (turnedPortable)
              await this.deps.log.append(trx, {
                sessionId: ctx.turn.sessionId,
                events: [
                  {
                    type: "provider_thread.changed",
                    thread: providerThreadFromRow(turnedPortable),
                  },
                ],
              });
            await trx
              .updateTable("agent_turn_attempts")
              .set({
                runner: sql`jsonb_set(runner, '{applied}', coalesce(runner -> 'applied', '{}'::jsonb) || jsonb_build_object(${callId}::text, true))`,
              })
              .where("id", "=", ctx.attempt.id)
              .execute();
          });
          result = null;
        } else if (call.kind === "native_state.load") {
          result =
            (await this.native.load({
              threadId,
              ...(call.subpath ? { subpath: call.subpath } : {}),
            })) ?? null;
        } else if (call.kind === "native_state.subpaths") {
          result = await this.native.subpaths({ threadId });
        } else if (refusal) {
          error = refusal;
        } else {
          const answer = await this.deps.host.hostTool({
            identity: ctx.identity,
            session: ctx.session,
            turn: ctx.turn,
            name: call.name,
            input: call.input,
          });
          result = answer as unknown as JsonValue;
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      await this.sendResults(
        local,
        ctx.attempt.id,
        channel,
        error === undefined
          ? [{ callId, result: result ?? null }]
          : [{ callId, error }],
      );
    }
  }

  /**
   * Send host results. A call is forgotten once the runner acknowledges
   * its result; until then it is sent again (and answered again after a
   * takeover).
   */
  private async sendResults(
    local: LocalTurn,
    attemptId: string,
    channel: RunnerChannel,
    results: ReadonlyArray<
      { callId: string; result: JsonValue } | { callId: string; error: string }
    >,
  ): Promise<void> {
    const frames = results.map(
      (answer): RunnerCommandFrame => ({
        id: `result:${attemptId}:${answer.callId}`,
        command: {
          kind: "host_result",
          callId: answer.callId,
          ...("error" in answer
            ? { error: { message: answer.error } }
            : { result: answer.result }),
        },
      }),
    );
    for (const frame of frames) local.results.set(frame.id, frame);
    local.resultsSentAt = Date.now();
    await channel
      .send(frames)
      .catch((caught) =>
        console.warn("[catamorphic] Could not send a host result", caught),
      );
  }

  private async forgetCall(
    trx: Transaction<DB>,
    attemptId: string,
    callId: string,
  ): Promise<void> {
    await trx
      .updateTable("agent_turn_attempts")
      .set({
        runner: sql`runner #- ARRAY['calls', ${callId}::text] #- ARRAY['applied', ${callId}::text]`,
      })
      .where("id", "=", attemptId)
      .execute();
  }

  /** A native state call's thread: the attempt's, or a fork's source. */
  private async threadForCall(
    attempt: Attempt,
    call: HostCall,
  ): Promise<string> {
    const own = attempt.providerThreadId;
    if (!own) throw new Error("The attempt has no provider thread");
    // A fork reads its source, never writes it: appends go to its own thread.
    if (
      call.kind === "tool" ||
      call.kind === "native_state.append" ||
      !call.thread
    )
      return own;
    const rows = await this.deps.db
      .selectFrom("agent_provider_threads")
      .select(["id", "native_ref", "fork_source", "last_turn_ordinal"])
      .where("session_id", "=", attempt.sessionId)
      .execute();
    const match = rows.find(
      (row) =>
        (row.native_ref as unknown as NativeRef | null)?.id === call.thread,
    );
    if (match) return match.id;
    // A fork reads its source thread, which belongs to the source session,
    // only to begin: once a turn of its own settled (its last turn is no
    // longer the one it was born at), never again.
    const ownRow = rows.find((row) => row.id === own);
    const source =
      (ownRow?.fork_source as unknown as {
        threadId?: string;
        source?: NativeRef;
        bornAtOrdinal?: number | null;
      } | null) ?? null;
    if (
      ownRow?.last_turn_ordinal === (source?.bornAtOrdinal ?? null) &&
      source?.threadId &&
      source.source?.id === call.thread
    )
      return source.threadId;
    return own;
  }

  /** Send again the results the runner has not acknowledged in a while. */
  private async resendResults(
    local: LocalTurn,
    attemptId: string,
    channel: RunnerChannel,
  ): Promise<void> {
    // A send can fail, and the harness waits on every call.
    if (
      local.results.size === 0 ||
      Date.now() - local.resultsSentAt <= RESULT_RESEND_MS
    )
      return;
    local.resultsSentAt = Date.now();
    // Only this attempt's: an earlier attempt's runner is gone, and its
    // call ids mean other calls to this one.
    const own = `result:${attemptId}:`;
    for (const id of local.results.keys())
      if (!id.startsWith(own)) local.results.delete(id);
    await channel
      .send([...local.results.values()])
      .catch((error) =>
        console.warn("[catamorphic] Could not send host results", error),
      );
  }

  /**
   * Answer the runner of an attempt that ended until it exits. A harness
   * may still store native state on its way out (Claude Code flushes its
   * transcript after its result, the Codex adapter stores the rollout lines
   * Codex wrote as it shut down), and a thread resumed anywhere else needs
   * all of it. The runner is told to stop at once, which an attempt that
   * ended ignores while it winds down; its events are over, and a tool it
   * still calls is refused. One still up after RUNNER_EXIT_GRACE_MS is
   * ended.
   */
  private async drainRunner(
    local: LocalTurn,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
    },
    channel: RunnerChannel,
    from: number,
  ): Promise<void> {
    if (local.abort.signal.aborted) return;
    await withSpan(
      {
        tracer,
        name: "agent.runner.drain",
        attributes: {
          "catamorphic.agent.turn.id": ctx.turn.id,
          "catamorphic.agent.attempt.id": ctx.attempt.id,
          "catamorphic.agent.runner.location": channel.location.kind,
        },
      },
      async (span) => {
        const exited = await this.answerUntilExit(local, ctx, channel, from);
        span.setAttribute("catamorphic.agent.runner.exited", exited);
      },
    );
  }

  /** drainRunner's reading; whether the runner exited by itself. */
  private async answerUntilExit(
    local: LocalTurn,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
    },
    channel: RunnerChannel,
    from: number,
  ): Promise<boolean> {
    const grace = Date.now() + RUNNER_EXIT_GRACE_MS;
    let cursor = from;
    let exited = false;
    try {
      await channel
        .send([{ id: `stop:${randomUUID()}`, command: { kind: "stop" } }])
        .catch(() => {});
      for (;;) {
        if (local.abort.signal.aborted) return false;
        // A runner in this process dies with it: while it stops, the turn
        // settles in time instead.
        const deadline =
          channel.location.kind === "in_process" &&
          this.stopDeadline !== undefined
            ? Math.min(grace, this.stopDeadline - STOP_SETTLE_MS)
            : grace;
        const left = deadline - Date.now();
        if (left <= 0) {
          console.warn(
            `[catamorphic] agent runner (turn ${ctx.turn.id}) was still up when its attempt's wind-down ran out of time; ending it`,
          );
          return false;
        }
        await this.resendResults(local, ctx.attempt.id, channel);
        const read = await channel.read({
          cursor,
          waitMs: Math.min(
            left,
            channel.location.kind === "in_process" ? 500 : 2_000,
          ),
        });
        for (const line of read.diagnostics)
          console.warn(
            `[catamorphic] agent runner (turn ${ctx.turn.id}): ${local.mask?.text(line) ?? line}`,
          );
        cursor = read.cursor;
        const calls: Array<[string, HostCall]> = [];
        for (const frame of read.frames) {
          if (frame.type === "call") calls.push([frame.callId, frame.call]);
          else if (frame.type === "ack") local.results.delete(frame.commandId);
        }
        if (calls.length > 0)
          await this.answerCalls(local, ctx, channel, calls, ENDED_TOOL);
        // Its exit frame is its last word, whenever its process goes.
        exited =
          read.exited || read.frames.some((frame) => frame.type === "exit");
        if (exited) return true;
      }
    } catch (error) {
      console.warn(
        "[catamorphic] Could not answer an ended attempt's runner",
        error,
      );
      return false;
    } finally {
      // Lost or handed back: as for any runner of an aborted turn.
      if (!local.abort.signal.aborted) {
        if (!exited || channel.location.kind === "in_process")
          await channel
            .kill()
            .catch((error) =>
              console.warn(
                "[catamorphic] Could not end an agent runner",
                error,
              ),
            );
        if (local.channel === channel) local.channel = undefined;
        // Only a runner in a sandbox outlives its holder for another to find.
        if (channel.location.kind === "sandbox_process")
          await this.markEnded(local, ctx.attempt.id);
      }
    }
  }

  /** Record that an ended attempt's runner needs nobody any more. */
  private async markEnded(local: LocalTurn, attemptId: string): Promise<void> {
    await this.deps.db
      .transaction()
      .execute(async (trx) => {
        await this.assertOwned(local, trx);
        await trx
          .updateTable("agent_turn_attempts")
          .set({ runner: sql`jsonb_set(runner, '{ended}', 'true'::jsonb)` })
          .where("id", "=", attemptId)
          .execute();
      })
      .catch((error) =>
        console.warn("[catamorphic] Could not record an ended runner", error),
      );
  }

  /**
   * Taken over while it finalized or restarted: a sandbox runner its last
   * holder may still have been answering is reattached, its calls that
   * holder recorded are answered again, and it is read on from the cursor
   * recorded for it. Where it starts reading, when there is one.
   */
  private async reattachEnded(
    local: LocalTurn,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt & { runner: RunnerState | null };
    },
  ): Promise<number | undefined> {
    const runner = ctx.attempt.runner;
    const location = runner?.location;
    if (
      local.channel ||
      !runner ||
      runner.ended ||
      location?.kind !== "sandbox_process"
    )
      return undefined;
    let channel: RunnerChannel | undefined;
    try {
      channel = await this.deps.host.reattach({
        identity: ctx.identity,
        session: ctx.session,
        location,
      });
    } catch (error) {
      // Left for whoever takes the turn over next to try again.
      console.warn(
        "[catamorphic] Could not reattach an ended attempt's runner",
        error,
      );
      return undefined;
    }
    if (!channel) {
      // Gone with its process: nothing is left to answer.
      await this.markEnded(local, ctx.attempt.id);
      return undefined;
    }
    try {
      await this.maskTakenOver(local, ctx);
    } catch (error) {
      // Nothing it says could be masked: it is ended unread.
      console.warn("[catamorphic] Could not mask a reattached runner", error);
      await channel.kill().catch(() => {});
      await this.markEnded(local, ctx.attempt.id);
      return undefined;
    }
    local.channel = channel;
    await this.answerCalls(
      local,
      ctx,
      channel,
      Object.entries(runner.calls),
      TAKEN_OVER_TOOL,
    );
    return runner.cursor;
  }

  /** Taken over: every value the chat could repeat is masked, as its preparer masked it (ADR 0206). */
  private async maskTakenOver(
    local: LocalTurn,
    ctx: { identity: Identity; session: SessionRow },
  ): Promise<void> {
    if (local.mask) return;
    local.mask = new SecretMask(
      (await this.deps.host.secretValues?.({
        identity: ctx.identity,
        session: ctx.session,
      })) ?? {},
    );
  }

  private async stopRunner(
    local: LocalTurn,
    channel: RunnerChannel | undefined,
  ): Promise<void> {
    if (!channel) return;
    // A runner on a sandbox that outlives this holder is left for the next.
    if (local.handingBack) return;
    await channel
      .send([{ id: `stop:${randomUUID()}`, command: { kind: "stop" } }])
      .catch(() => {});
    if (channel.location.kind === "in_process") await channel.kill();
  }

  // -------------------------------------------------------------------------
  // Settling

  private async finalize(
    local: LocalTurn,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
      completion: {
        status: "completed" | "failed" | "interrupted";
        error?: TurnError;
      };
      /** How far the attempt's runner, still up, was read. */
      cursor?: number;
    },
  ): Promise<void> {
    const { db, log } = this.deps;
    local.finalizing = true;
    let turn: Turn = ctx.turn;
    if (turn.status !== "finalizing") {
      turn = {
        ...turn,
        status: "finalizing",
        activity: "Saving changes",
        activityAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await db.transaction().execute(async (trx) => {
        await this.assertOwned(local, trx);
        await log.append(trx, {
          sessionId: turn.sessionId,
          events: [{ type: "turn.changed", turn }],
        });
      });
    }
    const inputItem = turn.inputItemId
      ? await db
          .selectFrom("agent_items")
          .select("payload")
          .where("id", "=", turn.inputItemId)
          .executeTakeFirst()
      : undefined;
    const inputText = inputItem
      ? itemText(itemFromRow(inputItem))
      : CONTINUATION_PROMPT;
    // Its runner is answered while the host finalizes, so the turn settles
    // with everything its harness stored on the way out.
    const drained =
      local.channel && ctx.cursor !== undefined
        ? this.drainRunner(local, ctx, local.channel, ctx.cursor)
        : undefined;
    let finalized: FinalizedTurn;
    try {
      finalized = await this.deps.host.finalize({
        identity: ctx.identity,
        session: ctx.session,
        turn,
        inputText,
        completion: { status: ctx.completion.status },
      });
    } finally {
      await drained;
    }
    const status = finalized.failure ? "failed" : ctx.completion.status;
    await this.settle(local, {
      identity: ctx.identity,
      session: ctx.session,
      turn,
      attempt: ctx.attempt,
      status,
      error: finalized.failure ?? ctx.completion.error ?? null,
      outcome: { ...turn.outcome, ...finalized.outcome },
      checkpointAfter: finalized.checkpointAfter,
    });
  }

  private async settle(
    local: LocalTurn,
    input: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
      status: "completed" | "failed" | "interrupted";
      error?: TurnError | null;
      outcome: TurnOutcome;
      checkpointAfter: string | null;
    },
  ): Promise<void> {
    const { db, log, queue } = this.deps;
    const now = new Date().toISOString();
    let transient =
      input.status === "failed" &&
      input.error?.retrySafe === true &&
      (input.error.kind === "rate_limit" ||
        input.error.kind === "unavailable") &&
      input.turn.attemptCount < MAX_TRANSIENT_RETRIES;
    const delay =
      BACKOFF_MS[
        Math.min(input.turn.attemptCount - 1, BACKOFF_MS.length - 1)
      ] ?? 60_000;
    const retryAt = transient
      ? new Date(Date.now() + delay + Math.floor(Math.random() * delay * 0.2))
      : null;
    let settled: Turn = {
      ...input.turn,
      status: transient ? "queued" : input.status,
      activity: null,
      activityAt: null,
      cancellationRequested: false,
      error: input.status === "completed" ? null : (input.error ?? null),
      outcome: input.outcome,
      checkpoint: {
        ...input.turn.checkpoint,
        after: input.checkpointAfter ?? input.turn.checkpoint.after,
      },
      retryAt: retryAt?.toISOString() ?? null,
      completedAt: transient ? null : now,
      updatedAt: now,
    };
    let reply: Item | null = null;
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      // Input delivered while the turn ends either commits before the
      // steered items are read (and runs as a turn of its own) or waits
      // and finds no turn to join: never steered into a settled turn.
      await log.lock(trx, input.turn.sessionId);
      // A person's stop stands: a turn they stopped is not tried again.
      if (transient) {
        const stop = await trx
          .selectFrom("agent_turns")
          .select("cancellation_requested_at")
          .where("id", "=", input.turn.id)
          .executeTakeFirst();
        if (stop?.cancellation_requested_at) {
          transient = false;
          settled = {
            ...settled,
            status: "interrupted",
            retryAt: null,
            completedAt: now,
          };
        }
      }
      const events: SessionEvent[] = [];
      if (
        input.attempt.status === "preparing" ||
        input.attempt.status === "running"
      )
        events.push({
          type: "attempt.changed",
          attempt: {
            ...input.attempt,
            status:
              input.status === "completed"
                ? "completed"
                : input.status === "interrupted"
                  ? "interrupted"
                  : "failed",
            completedAt: now,
            error: input.error ?? null,
          },
        });
      // Whatever the attempt left open closes with the turn.
      events.push(
        ...(await closeOpenWork(trx, {
          turn: input.turn,
          attemptId: input.attempt.id,
          reason: "The turn ended before it was answered.",
          now,
        })),
      );
      events.push({ type: "turn.changed", turn: settled });
      if (!transient)
        events.push(...(await this.requeueSteers(trx, input.turn, now)));
      if (input.attempt.providerThreadId && input.status !== "failed") {
        const threadRow = await trx
          .selectFrom("agent_provider_threads")
          .selectAll()
          .where("id", "=", input.attempt.providerThreadId)
          .executeTakeFirst();
        if (threadRow)
          events.push({
            type: "provider_thread.changed",
            thread: {
              ...providerThreadFromRow(threadRow),
              lastTurnOrdinal: input.turn.ordinal,
              updatedAt: now,
            },
          });
      }
      const needsAttention =
        (input.status === "failed" && !transient) ||
        input.outcome.notification !== undefined;
      if (needsAttention)
        events.push({
          type: "session.changed",
          session: {
            attentionRevision: Number(input.session.attention_revision) + 1,
          },
        });
      await log.append(trx, { sessionId: input.turn.sessionId, events });
      await queue.markCommands({
        ids: (
          await queue.openCommands({ turnId: input.turn.id, executor: trx })
        ).map((command) => command.id),
        status: "dropped",
        executor: trx,
      });
      if (retryAt)
        await queue.scheduleRetry(trx, { turnId: input.turn.id, at: retryAt });
      await queue.release(trx, { turnId: input.turn.id });
      const replyRow = await trx
        .selectFrom("agent_items")
        .select("payload")
        .where("turn_id", "=", input.turn.id)
        .where("kind", "=", "assistant_message")
        .orderBy("position", "desc")
        .limit(1)
        .executeTakeFirst();
      reply = replyRow ? itemFromRow(replyRow) : null;
    });
    await this.deps.host
      .settled({
        identity: input.identity,
        session: input.session,
        turn: settled,
        reply,
        retrying: transient,
      })
      .catch((error) =>
        console.warn("[catamorphic] After-turn work failed", error),
      );
  }

  /**
   * An attempt whose runner is gone (ADR 0198): it is lost, its turn is
   * interrupted with the reason, open requests can no longer be answered,
   * and a continuation is queued once when the agent recovers by
   * continuing and its native thread can be resumed exactly.
   */
  private async lose(
    local: LocalTurn,
    ctx: {
      identity: Identity;
      session: SessionRow;
      turn: Turn;
      attempt: Attempt;
      reason: string;
    },
  ): Promise<void> {
    const { db, log, queue } = this.deps;
    const now = new Date().toISOString();
    const harness = await this.deps.host
      .harnessOf({ identity: ctx.identity, session: ctx.session })
      .catch(() => ({ harness: "", agentId: null, recovery: "stop" as const }));
    let continued = false;
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      // Read under the lock: an interrupt made meanwhile means no continuation.
      await log.lock(trx, ctx.turn.sessionId);
      const turn = turnFromRow(
        await trx
          .selectFrom("agent_turns")
          .selectAll()
          .where("id", "=", ctx.turn.id)
          .executeTakeFirstOrThrow(),
      );
      const events: SessionEvent[] = [
        {
          type: "attempt.changed",
          attempt: {
            ...ctx.attempt,
            status: "lost",
            completedAt: now,
            error: { message: ctx.reason },
          },
        },
        ...(await closeOpenWork(trx, {
          turn,
          attemptId: ctx.attempt.id,
          reason: "The agent that asked stopped before it was answered.",
          now,
        })),
        {
          type: "turn.changed",
          turn: {
            ...turn,
            status: "interrupted",
            activity: null,
            activityAt: null,
            cancellationRequested: false,
            error: { message: ctx.reason },
            completedAt: now,
            updatedAt: now,
          },
        },
      ];
      // A person's steered messages run as turns of their own; then there
      // is newer work, and nothing to continue on its own.
      const requeued = await this.requeueSteers(trx, turn, now);
      events.push(...requeued);
      const thread = ctx.attempt.providerThreadId
        ? await trx
            .selectFrom("agent_provider_threads")
            .selectAll()
            .where("id", "=", ctx.attempt.providerThreadId)
            .executeTakeFirst()
        : undefined;
      const strong =
        (thread?.native_ref as unknown as NativeRef | null)?.strength ===
        "strong";
      // The thread took this turn's input before its runner went away: a
      // continuation on it is not handed the turn again.
      if (thread)
        events.push({
          type: "provider_thread.changed",
          thread: {
            ...providerThreadFromRow(thread),
            lastTurnOrdinal: turn.ordinal,
            updatedAt: now,
          },
        });
      const newer = await trx
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", turn.sessionId)
        .where("ordinal", ">", turn.ordinal)
        .executeTakeFirst();
      const alreadyContinued = await trx
        .selectFrom("agent_turns")
        .select("id")
        .where("continuation_of", "=", turn.id)
        .executeTakeFirst();
      if (
        harness.recovery === "continue" &&
        strong &&
        !newer &&
        requeued.length === 0 &&
        !alreadyContinued &&
        // A continuation that is lost too is not continued again: a machine
        // that keeps dying would chain them without end.
        turn.continuationOf === null &&
        !turn.cancellationRequested &&
        ctx.session.status === "active"
      ) {
        const noticeId = derivedId(turn.id, "continued");
        const ordinal = turn.ordinal + 1;
        const turnId = derivedId(turn.id, "continuation");
        events.push(
          {
            type: "item.added",
            item: {
              id: noticeId,
              sessionId: turn.sessionId,
              turnId,
              attemptId: null,
              parentItemId: null,
              position: 0,
              status: "completed",
              nativeRef: null,
              createdAt: now,
              updatedAt: now,
              startedAt: now,
              endedAt: now,
              kind: "notice",
              code: "turn_continued",
              text: "The machine running the last turn stopped. The agent continues where it left off.",
              data: { continuationOf: turn.id },
            },
          },
          {
            type: "turn.changed",
            turn: {
              id: turnId,
              sessionId: turn.sessionId,
              ordinal,
              status: "queued",
              inputItemId: noticeId,
              dispatch: "queue",
              priority: 0,
              activity: null,
              activityAt: null,
              attemptCount: 0,
              activeAttemptId: null,
              providerThreadId: ctx.attempt.providerThreadId,
              retryAt: null,
              cancellationRequested: false,
              error: null,
              outcome: null,
              checkpoint: { before: null, after: null },
              continuationOf: turn.id,
              createdAt: now,
              startedAt: null,
              completedAt: null,
              updatedAt: now,
            },
          },
        );
        continued = true;
      }
      await log.append(trx, {
        sessionId: turn.sessionId,
        commandId: `continue:${turn.id}`,
        events,
      });
      await queue.markCommands({
        ids: (await queue.openCommands({ turnId: turn.id, executor: trx })).map(
          (command) => command.id,
        ),
        status: "dropped",
        executor: trx,
      });
      await queue.release(trx, { turnId: turn.id });
    });
    if (local.channel) await local.channel.kill().catch(() => {});
    await this.deps.host
      .settled({
        identity: ctx.identity,
        session: ctx.session,
        turn: {
          ...ctx.turn,
          status: "interrupted",
          error: { message: ctx.reason },
        },
        reply: null,
        retrying: continued,
      })
      .catch((error) =>
        console.warn("[catamorphic] After-turn work failed", error),
      );
  }

  /** Items steered into a turn after its input, in order. */
  private async steeredItemIds(
    turn: Turn,
    executor: Kysely<DB> | Transaction<DB> = this.deps.db,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom("agent_items")
      .select("id")
      .where("turn_id", "=", turn.id)
      .where("kind", "in", [...INPUT_ITEM_KINDS])
      .$if(turn.inputItemId !== null, (query) =>
        query.where("id", "!=", turn.inputItemId ?? ""),
      )
      .orderBy("position")
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Input steered into a turn that the harness never took in (accepted,
   * then the turn ended) runs as turns of its own after it, in order: a
   * person's message is never dropped.
   */
  /** The steer commands among `ids` whose message a person wrote. */
  private async fromPeople(
    trx: Transaction<DB>,
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const commands = await trx
      .selectFrom("agent_turn_commands")
      .select(["id", "payload"])
      .where("id", "in", [...ids])
      .execute();
    const itemOf = new Map(
      commands.map((command) => {
        const payload = command.payload as { itemId?: unknown } | null;
        return [
          command.id,
          typeof payload?.itemId === "string" ? payload.itemId : "",
        ];
      }),
    );
    const itemIds = [...new Set(itemOf.values())].filter(Boolean);
    if (itemIds.length === 0) return [];
    const items = await trx
      .selectFrom("agent_items")
      .select(["id", "author_kind"])
      .where("id", "in", itemIds)
      .execute();
    const authors = new Map(items.map((item) => [item.id, item.author_kind]));
    return ids.filter((id) => authors.get(itemOf.get(id) ?? "") === "user");
  }

  private async requeueSteers(
    trx: Transaction<DB>,
    turn: Turn,
    now: string,
  ): Promise<SessionEvent[]> {
    const steered = await this.steeredItemIds(turn, trx);
    if (steered.length === 0) return [];
    const attempts = await trx
      .selectFrom("agent_turn_attempts")
      .select("runner")
      .where("turn_id", "=", turn.id)
      .execute();
    const consumed = new Set(
      attempts.flatMap(
        (row) => (row.runner as unknown as RunnerState | null)?.consumed ?? [],
      ),
    );
    const pending = steered.filter((id) => !consumed.has(id));
    if (pending.length === 0) return [];
    const last = await trx
      .selectFrom("agent_turns")
      .select((eb) => eb.fn.max("ordinal").as("ordinal"))
      .where("session_id", "=", turn.sessionId)
      .executeTakeFirst();
    let ordinal = Number(last?.ordinal ?? turn.ordinal);
    const events: SessionEvent[] = [];
    // Task notifications go on together, in the turn already waiting for
    // them or the first one queued here (ADR 0217), when they are as much
    // the owner's as that turn's input (ADR 0199).
    const session = await trx
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", turn.sessionId)
      .executeTakeFirstOrThrow();
    const ownersOf = async (item: InputItem) =>
      this.deps.host.authoredByOwner({ session, item });
    const waiting = await waitingNotificationTurn(trx, turn.sessionId);
    const waitingInput = waiting?.inputItemId
      ? await trx
          .selectFrom("agent_items")
          .select("payload")
          .where("id", "=", waiting.inputItemId)
          .executeTakeFirst()
          .then((row) => (row ? itemFromRow(row) : null))
      : null;
    let notifications =
      waiting && waitingInput && isInputItem(waitingInput)
        ? { id: waiting.id, owned: await ownersOf(waitingInput) }
        : undefined;
    for (const itemId of pending) {
      const row = await trx
        .selectFrom("agent_items")
        .select("payload")
        .where("id", "=", itemId)
        .executeTakeFirst();
      if (!row) continue;
      const item = itemFromRow(row);
      if (
        item.kind === "task_notification" &&
        notifications &&
        notifications.owned === (await ownersOf(item))
      ) {
        events.push({
          type: "item.changed",
          item: {
            ...item,
            turnId: notifications.id,
            dispatch: "queue",
            updatedAt: now,
          },
        });
        continue;
      }
      ordinal += 1;
      const next: Turn = {
        id: derivedId(turn.id, `steer:${itemId}`),
        sessionId: turn.sessionId,
        ordinal,
        status: "queued",
        inputItemId: itemId,
        dispatch: "queue",
        priority: 0,
        activity: null,
        activityAt: null,
        attemptCount: 0,
        activeAttemptId: null,
        providerThreadId: turn.providerThreadId,
        retryAt: null,
        cancellationRequested: false,
        error: null,
        outcome: null,
        checkpoint: { before: null, after: null },
        continuationOf: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      };
      if (item.kind === "task_notification")
        notifications = { id: next.id, owned: await ownersOf(item) };
      events.push(
        { type: "turn.changed", turn: next },
        {
          type: "item.changed",
          item: isInputItem(item)
            ? { ...item, turnId: next.id, dispatch: "queue", updatedAt: now }
            : { ...item, turnId: next.id, updatedAt: now },
        },
      );
    }
    return events;
  }

  /** A failure outside the protocol (preparation threw): the turn fails, saying why. */
  private async failUnexpectedly(
    local: LocalTurn,
    error: unknown,
  ): Promise<void> {
    const turn = await this.loadTurn(local.claim.turn.id);
    if (
      !["preparing", "running", "waiting", "finalizing"].includes(turn.status)
    )
      return;
    const session = await this.deps.db
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", turn.sessionId)
      .executeTakeFirstOrThrow();
    const identity = await this.deps.host.owner(session);
    if (!identity) return;
    const attemptRow = turn.activeAttemptId
      ? await this.deps.db
          .selectFrom("agent_turn_attempts")
          .selectAll()
          .where("id", "=", turn.activeAttemptId)
          .executeTakeFirst()
      : undefined;
    const now = new Date().toISOString();
    const attempt: Attempt = attemptRow
      ? attemptFromRow(attemptRow)
      : {
          id: derivedId(turn.id, "failed"),
          turnId: turn.id,
          sessionId: turn.sessionId,
          ordinal: turn.attemptCount + 1,
          reason: "initial",
          status: "preparing",
          providerThreadId: null,
          nativeTurnRef: null,
          error: null,
          createdAt: now,
          startedAt: now,
          completedAt: null,
        };
    if (local.channel) await this.stopRunner(local, local.channel);
    await this.settle(local, {
      identity,
      session,
      turn,
      attempt,
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
      outcome: turn.outcome ?? { changedFiles: [] },
      checkpointAfter: null,
    });
  }

  private async assertOwned(
    local: LocalTurn,
    trx: Transaction<DB>,
  ): Promise<void> {
    const owned = await this.deps.queue.owns({
      turnId: local.claim.turn.id,
      leaseToken: local.claim.leaseToken,
      executor: trx,
    });
    if (!owned) {
      local.abort.abort();
      throw new TurnLeaseLostError(local.claim.turn.id);
    }
  }
}

/** An attempt row with its runner state and when its provider started. */
function withRunner(
  row: Selectable<DB["agent_turn_attempts"]>,
): Attempt & { runner: RunnerState | null; providerStartedAt: Date | null } {
  return {
    ...attemptFromRow(row),
    runner: (row.runner as unknown as RunnerState | null) ?? null,
    providerStartedAt: row.provider_started_at,
  };
}

/** This process no longer holds the turn: another took it over. */
export class TurnLeaseLostError extends Error {
  constructor(readonly turnId: string) {
    super("Execution ownership was lost. Another machine continues this turn.");
    this.name = "TurnLeaseLostError";
  }
}

// Replica memory (c): a constant, the same on every replica.
const QUEUED_COMMAND_KINDS: ReadonlySet<string> = new Set<TurnCommandKind>([
  "steer",
  "interrupt",
  "respond",
  "release",
  "stop",
]);

function splitCommandId(id: string): [string, string | undefined] {
  const index = id.indexOf(":");
  return index < 0
    ? [id, undefined]
    : [id.slice(0, index), id.slice(index + 1)];
}

function attemptOutcome(
  attempt: Attempt,
): "completed" | "failed" | "interrupted" {
  return attempt.status === "completed"
    ? "completed"
    : attempt.status === "interrupted" ||
        attempt.status === "superseded" ||
        attempt.status === "lost"
      ? "interrupted"
      : "failed";
}

/** What a turn was asked: the words it answers, or a notification's summary. */
function itemText(item: Item): string {
  switch (item.kind) {
    case "user_message":
    case "inbound_message":
    case "notice":
      return item.text;
    case "task_notification":
      return item.summary;
    default:
      return "";
  }
}

/**
 * Close what an attempt left open: in-progress items are cancelled and
 * pending requests can no longer be answered.
 */
async function closeOpenWork(
  trx: Transaction<DB>,
  input: { turn: Turn; attemptId: string; reason: string; now: string },
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const requests = await trx
    .selectFrom("agent_runtime_requests")
    .selectAll()
    .where("session_id", "=", input.turn.sessionId)
    .where("turn_id", "=", input.turn.id)
    .where("status", "=", "pending")
    .execute();
  // A non-blocking question outlives its turn: its answer becomes a message.
  const outliving = new Set(
    requests
      .map(requestFromRow)
      .filter((request) => !request.blocking && request.kind === "question")
      .map((request) => request.id),
  );
  const items = await trx
    .selectFrom("agent_items")
    .select("payload")
    .where("turn_id", "=", input.turn.id)
    .where("status", "=", "in_progress")
    .execute();
  for (const row of items) {
    const item = itemFromRow(row);
    if (item.kind === "request" && outliving.has(item.requestId)) continue;
    events.push({
      type: "item.changed",
      item: {
        ...item,
        status: "cancelled",
        endedAt: input.now,
        updatedAt: input.now,
      } as Item,
    });
  }
  for (const row of requests) {
    const request: RuntimeRequest = requestFromRow(row);
    if (outliving.has(request.id)) continue;
    events.push({
      type: "request.changed",
      request: {
        ...request,
        status: "expired",
        answerable: false,
        reason: input.reason,
        resolvedAt: input.now,
      },
    });
  }
  return events;
}

export type { JsonObject };

/** Whether a read carried only streamed text or output, mid-item. */
function onlyDeltas(read: RunnerRead): boolean {
  return (
    !read.exited &&
    read.frames.length > 0 &&
    read.frames.every(
      (frame) => frame.type === "event" && frame.event.type === "item.delta",
    )
  );
}

/** Sleep, ending early when `signal` aborts or `wake` resolves. */
function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
  wake?: Promise<void>,
) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    void wake?.then(done);
  });
}

/**
 * How long a host's retry of a failed attempt waits, from its answer
 * (ADR 0227): never less than nothing, never past {@link HOST_RETRY_MAX_MS},
 * and no wait at all for an answer that is not a number.
 */
export function hostRetryDelay(afterMs: number): number {
  if (Number.isNaN(afterMs)) return 0;
  return Math.min(HOST_RETRY_MAX_MS, Math.max(0, afterMs));
}
