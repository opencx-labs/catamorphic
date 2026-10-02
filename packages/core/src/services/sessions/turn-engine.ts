import { randomUUID } from "node:crypto";
import type {
  AgentAttachment,
  Attempt,
  AttemptReason,
  Item,
  JsonObject,
  JsonValue,
  NativeRef,
  ProviderThread,
  RuntimeRequest,
  RuntimeRequestResponse,
  SessionEvent,
  Turn,
  TurnError,
  TurnOutcome,
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
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Identity } from "../../identity.js";
import {
  type HeldTurnLease,
  type RenewedTurnLease,
  startTurnLeaseRenewal,
} from "../agent-turn-leases.js";
import { buildContextHandoff } from "./context-handoff.js";
import { NativeStateStore } from "./native-state.js";
import {
  reattachInProcessRunner,
  type RunnerChannel,
  type RunnerLocation,
} from "./runner-channels.js";
import type { SessionLog } from "./session-log.js";
import {
  attemptFromRow,
  itemFromRow,
  providerThreadFromRow,
  requestFromRow,
  type SessionRow,
  turnFromRow,
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
  /** Host calls taken and not answered yet, answered again after a takeover. */
  calls: Record<string, HostCall>;
  /** Steered inputs the harness could not take; the attempt restarts with them. */
  restartWith: string[];
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
}

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
  /** After a turn settled, outside its transaction: delegation, notifications, hooks. */
  settled(input: {
    identity: Identity;
    session: SessionRow;
    turn: Turn;
    reply: Item | null;
    retrying: boolean;
  }): Promise<void>;
}

/** The model-facing text of an input item (a delivery's provenance included). */
export type InputText = (item: Item) => string;

interface LocalTurn {
  claim: ClaimedTurn;
  abort: AbortController;
  wake: () => void;
  waiter?: Promise<void>;
  /** The runner of the attempt running now, if any. */
  channel?: RunnerChannel;
  /** This process is stopping: hand reattachable work back instead. */
  handingBack: boolean;
  /** Host calls answered here, as `<attemptId>:<callId>`: never saved back. */
  answered: Set<string>;
}

/** The runner state to save: without calls this holder already answered. */
function unanswered(local: LocalTurn, attemptId: string, runner: RunnerState): RunnerState {
  const calls = Object.fromEntries(
    Object.entries(runner.calls).filter(([callId]) => !local.answered.has(`${attemptId}:${callId}`)),
  );
  return { ...runner, calls };
}

/** The text a continuation turn gives the agent (ADR 0196). */
export const CONTINUATION_PROMPT =
  "Your previous turn was interrupted because the machine running it stopped. Continue where you left off. First check what was already done (files, commands, messages) so you do not repeat anything that had side effects.";

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const MAX_TRANSIENT_RETRIES = 5;
const INTERRUPT_GRACE_MS = 30_000;

/**
 * Drives claimed turns (ADR 0196): prepares an attempt, starts its runner
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
    const pending: Promise<void>[] = [];
    for (const local of this.local.values()) {
      const location = local.channel?.location;
      if (location && input.reattachable(location)) {
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
        pending.push(this.requestInterrupt(local.claim.turn.id).catch(() => {}));
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
      answered: new Set(),
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
      await withSpan(
        {
          tracer,
          name: "agent.turn",
          attributes: {
            "catamorphic.agent.turn.id": claim.turn.id,
            "catamorphic.agent.session.id": claim.turn.sessionId,
            "catamorphic.agent.turn.recovered": claim.recovered,
          },
        },
        () => this.drive(local, rearm),
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
    }
  }

  // -------------------------------------------------------------------------

  private async drive(local: LocalTurn, rearm: () => void): Promise<void> {
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
    let turn = await this.loadTurn(turnId);
    for (;;) {
      if (local.abort.signal.aborted) return;
      if (turn.status === "finalizing") {
        const attempt = await this.activeAttempt(turn);
        await this.finalize(local, { identity, session, turn, attempt, completion: { status: attemptOutcome(attempt) } });
        return;
      }
      if (turn.status === "preparing") {
        const outcome = await this.prepareAndLaunch(local, { identity, session, turn });
        if (outcome.kind === "settled") return;
        turn = outcome.turn;
      }
      if (turn.status === "running" || turn.status === "waiting") {
        const attempt = await this.activeAttempt(turn);
        const result = await this.pump(local, rearm, { identity, session, turn, attempt });
        if (result.kind === "aborted") {
          // Lost or handed back: a sandbox runner stays for whoever holds
          // the turn next; one in this process cannot be reached by anyone
          // else, so it stops with this holder.
          if (result.channel?.location.kind === "in_process")
            await result.channel.kill().catch(() => {});
          return;
        }
        if (result.kind === "lost") {
          await this.lose(local, { identity, session, turn: result.turn, attempt: result.attempt, reason: result.reason });
          return;
        }
        if (result.kind === "restart") {
          turn = result.turn;
          continue;
        }
        await this.finalize(local, {
          identity,
          session,
          turn: result.turn,
          attempt: result.attempt,
          completion: result.completion,
        });
        return;
      }
      // Settled or queued meanwhile (a close, a cancel): nothing to run.
      return;
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

  private async activeAttempt(turn: Turn): Promise<Attempt & { runner: RunnerState | null; providerStartedAt: Date | null }> {
    const row = turn.activeAttemptId
      ? await this.deps.db
          .selectFrom("agent_turn_attempts")
          .selectAll()
          .where("id", "=", turn.activeAttemptId)
          .executeTakeFirst()
      : undefined;
    if (!row) throw new Error(`Turn ${turn.id} has no attempt`);
    return {
      ...attemptFromRow(row),
      runner: (row.runner as unknown as RunnerState | null) ?? null,
      providerStartedAt: row.provider_started_at,
    };
  }

  /** Why the next attempt of this turn runs. */
  private async nextReason(turn: Turn): Promise<{ reason: AttemptReason; previous: Attempt | null }> {
    const row = await this.deps.db
      .selectFrom("agent_turn_attempts")
      .selectAll()
      .where("turn_id", "=", turn.id)
      .orderBy("ordinal", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return { reason: "initial", previous: null };
    const previous = attemptFromRow(row);
    if (previous.status === "preparing") return { reason: previous.reason, previous };
    if (previous.status === "superseded") return { reason: "steer_restart", previous };
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
    const binding = await this.bindThread({ turn, attempt, harness: harness.harness, local });
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
    const input = await this.attemptInput({
      turn,
      attempt,
      reason,
      inputItem: inputItem ? itemFromRow(inputItem) : null,
      handoff: [binding.handoff, ...(prepared.notes ?? [])].filter(Boolean).join("\n\n") || null,
    });
    if (prepared.checkpointBefore !== undefined && turn.checkpoint.before === null)
      turn = { ...turn, checkpoint: { ...turn.checkpoint, before: prepared.checkpointBefore } };
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
    const runner: RunnerState = {
      location: channel.location,
      cursor: 0,
      hello: null,
      calls: {},
      restartWith: [],
      consumed: reason === "steer_restart" ? await this.steeredItemIds(turn) : [],
      interruptSentAt: null,
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
        .set({ runner: runner as unknown as Json, provider_started_at: new Date() })
        .where("id", "=", attempt.id)
        .execute();
      await log.append(trx, {
        sessionId: turn.sessionId,
        events: [
          { type: "attempt.changed", attempt },
          { type: "turn.changed", turn: running },
        ],
      });
    });
    await channel.send([
      { id: `start:${attempt.id}`, command: { kind: "start", attempt: start } },
    ]);
    return { kind: "running", turn: running };
  }

  /** The input the harness receives: the person's words, a handoff before them. */
  private async attemptInput(input: {
    turn: Turn;
    attempt: Attempt;
    reason: AttemptReason;
    inputItem: Item | null;
    handoff: string | null;
  }): Promise<AttemptStart["input"]> {
    const steered =
      input.reason === "steer_restart"
        ? await this.deps.db
            .selectFrom("agent_items")
            .select("payload")
            .where("turn_id", "=", input.turn.id)
            .where("kind", "=", "user_message")
            .$if(input.turn.inputItemId !== null, (query) =>
              query.where("id", "!=", input.turn.inputItemId ?? ""),
            )
            .orderBy("position")
            .execute()
        : [];
    const steerTexts = steered
      .map((row) => itemFromRow(row))
      .flatMap((item) => (item.kind === "user_message" ? [this.deps.inputText(item)] : []));
    const base = input.inputItem;
    const text =
      base?.kind === "user_message"
        ? this.deps.inputText(base)
        : base?.kind === "notice" && base.code === "turn_continued"
          ? CONTINUATION_PROMPT
          : base
            ? this.deps.inputText(base)
            : CONTINUATION_PROMPT;
    const attachments: AgentAttachment[] =
      base?.kind === "user_message" ? base.attachments : [];
    const body =
      input.reason === "steer_restart" && steerTexts.length > 0
        ? `Your previous attempt at this turn was stopped so you can take in more from the person:\n\n${steerTexts.join("\n\n")}`
        : text;
    const full = input.handoff ? `${input.handoff}\n\n---\n\n${body}` : body;
    return {
      itemId: base?.id ?? derivedId(input.attempt.id, "input"),
      text: full,
      attachments,
    };
  }

  /**
   * The native thread this attempt runs on (ADR 0196): the session's
   * thread for this harness, resumed (or restored from stored state); a
   * fork of a source thread for a forked session's first turn; else a fresh
   * one, told what it missed by a recorded handoff.
   */
  private async bindThread(input: {
    turn: Turn;
    attempt: Attempt;
    harness: string;
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
      binding = {
        mode: (await this.native.has({ threadId: thread.id })) ? "restore" : "resume",
        providerThreadId: thread.id,
        nativeRef,
        ...(sameHarness.state_path ? { statePath: sameHarness.state_path } : {}),
      };
      if (thread.lastTurnOrdinal !== null && thread.lastTurnOrdinal < input.turn.ordinal - 1) {
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
    const turn: Turn = { ...input.turn, providerThreadId: thread.id, updatedAt: now };
    const attempt: Attempt = { ...input.attempt, providerThreadId: thread.id };
    const events: SessionEvent[] = [
      { type: "provider_thread.changed", thread: { ...thread, updatedAt: now } },
      { type: "attempt.changed", attempt },
      { type: "turn.changed", turn },
    ];
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
        events: existing ? events.slice(0, 3) : events,
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
        completion: { status: "completed" | "failed" | "interrupted"; error?: TurnError };
      }
  > {
    const { db, log, queue } = this.deps;
    let runner = ctx.attempt.runner;
    let turn = ctx.turn;
    let attempt: Attempt = ctx.attempt;
    if (!runner)
      return { kind: "lost", turn, attempt, reason: "The agent's runner never started." };
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
      // Answer again what the previous holder took and did not answer.
      await this.answerCalls(local, ctx, channel, runner, Object.entries(runner.calls), true);
    }
    let thread = await this.loadThread(attempt.providerThreadId);
    let completion:
      | { status: "completed" | "failed" | "interrupted"; error?: TurnError; ref?: NativeRef }
      | undefined;
    let interruptAt = runner.interruptSentAt ? Date.parse(runner.interruptSentAt) : null;
    const agentId = ctx.session.agent_id;

    const sendCommands = async () => {
      const commands = await queue.openCommands({ turnId: turn.id });
      if (commands.length === 0) return;
      const frames: RunnerCommandFrame[] = [];
      for (const command of commands) {
        const frame = await this.commandFrame(command, attempt.id);
        if (frame) frames.push(frame);
      }
      await channel?.send(frames);
      await queue.markCommands({
        ids: commands.filter((command) => command.status === "pending").map((command) => command.id),
        status: "sent",
      });
      if (commands.some((command) => command.kind === "interrupt") && interruptAt === null)
        interruptAt = Date.now();
    };
    await sendCommands();

    let commandsInFlight: Promise<void> | undefined;
    for (;;) {
      if (local.abort.signal.aborted) return { kind: "aborted", channel };
      if (!commandsInFlight)
        commandsInFlight = local.waiter?.then(async () => {
          rearm();
          commandsInFlight = undefined;
          if (!local.abort.signal.aborted) await sendCommands().catch((error) =>
            console.warn("[catamorphic] Could not deliver turn commands", error),
          );
        });
      const read = await channel.read({
        cursor: runner.cursor,
        waitMs: runner.location.kind === "in_process" ? 500 : 2_000,
      });
      if (local.abort.signal.aborted) return { kind: "aborted", channel };
      for (const line of read.diagnostics)
        console.warn(`[catamorphic] agent runner (turn ${turn.id}): ${line}`);
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
        if (outcome.calls.length > 0)
          void this.answerCalls(local, ctx, channel, runner, outcome.calls, false).catch((error) =>
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
        if (completion.status === "interrupted" && runner.restartWith.length > 0) {
          // Steered input the harness could not take: a new attempt of the
          // same turn, on the same native thread, with that input.
          const superseded: Attempt = {
            ...attempt,
            status: "superseded",
            completedAt: new Date().toISOString(),
          };
          const preparing: Turn = { ...turn, status: "preparing", activity: "Taking in your message", updatedAt: new Date().toISOString() };
          await db.transaction().execute(async (trx) => {
            await this.assertOwned(local, trx);
            await queue.markCommands({
              ids: (await queue.openCommands({ turnId: turn.id, executor: trx }))
                .filter((command) => command.kind === "interrupt")
                .map((command) => command.id),
              status: "dropped",
              executor: trx,
            });
            await log.append(trx, {
              sessionId: turn.sessionId,
              events: [
                { type: "attempt.changed", attempt: superseded },
                { type: "turn.changed", turn: { ...preparing, cancellationRequested: false } },
              ],
            });
          });
          await this.stopRunner(local, channel);
          local.channel = undefined;
          return { kind: "restart", turn: { ...preparing, cancellationRequested: false } };
        }
        await this.stopRunner(local, channel);
        local.channel = undefined;
        return { kind: "completed", turn, attempt, completion };
      }
      if (read.exited)
        return {
          kind: "lost",
          turn,
          attempt,
          reason: "The agent stopped unexpectedly before it finished this turn.",
        };
      if (interruptAt !== null && Date.now() - interruptAt > INTERRUPT_GRACE_MS) {
        // A harness that ignores its interrupt is stopped by force.
        await channel.kill();
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
    attemptId: string,
  ): Promise<RunnerCommandFrame | null> {
    const id = `${command.kind}:${command.id}`;
    switch (command.kind) {
      case "interrupt":
        return { id, command: { kind: "interrupt" } };
      case "stop":
        return { id, command: { kind: "stop" } };
      case "steer": {
        const itemId = typeof command.payload.itemId === "string" ? command.payload.itemId : "";
        const row = await this.deps.db
          .selectFrom("agent_items")
          .select("payload")
          .where("id", "=", itemId)
          .executeTakeFirst();
        const item = row ? itemFromRow(row) : null;
        if (item?.kind !== "user_message") return null;
        return {
          id,
          command: {
            kind: "steer",
            input: { itemId, text: this.deps.inputText(item), attachments: item.attachments },
          },
        };
      }
      case "respond": {
        const requestKey = typeof command.payload.requestKey === "string" ? command.payload.requestKey : "";
        const response = command.payload.response as unknown as RuntimeRequestResponse | undefined;
        if (!requestKey || !response) return null;
        // A response for an earlier attempt's request has nobody to reach.
        if (command.attemptId && command.attemptId !== attemptId) return null;
        return { id, command: { kind: "respond", requestKey, response } };
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
    refusedSteers: string[];
    completion?: { status: "completed" | "failed" | "interrupted"; error?: TurnError; ref?: NativeRef };
  }> {
    const { db, log, queue } = this.deps;
    return db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      let runner: RunnerState = { ...input.runner, cursor: input.cursor };
      const events = input.frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []));
      const calls: Array<[string, HostCall]> = [];
      const acked: string[] = [];
      const refusedSteers: string[] = [];
      for (const frame of input.frames) {
        if (frame.type === "hello")
          runner = { ...runner, hello: { harness: frame.harness.id, capabilities: frame.harness.capabilities } };
        else if (frame.type === "call") {
          if (!(frame.callId in runner.calls)) {
            runner = { ...runner, calls: { ...runner.calls, [frame.callId]: frame.call } };
            calls.push([frame.callId, frame.call]);
          }
        } else if (frame.type === "ack") {
          // Only queued turn commands are acknowledged in Postgres; the
          // engine's own (start, result, stop) are not rows.
          const [kind, commandId] = splitCommandId(frame.commandId);
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
          turn: input.turn,
          attempt: input.attempt,
          thread: input.thread,
          agentId: input.agentId,
        },
        events,
        now: new Date(),
      });
      if (ingested.consumed.length > 0)
        runner = { ...runner, consumed: [...(runner.consumed ?? []), ...ingested.consumed] };
      let turn = ingested.turn;
      const extra: SessionEvent[] = [];
      if (ingested.title) extra.push({ type: "session.changed", session: { title: ingested.title } });
      if (ingested.usage) {
        turn = {
          ...turn,
          outcome: { changedFiles: turn.outcome?.changedFiles ?? [], ...turn.outcome, usage: ingested.usage },
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
          ...(ingested.completed.ref ? { nativeTurnRef: ingested.completed.ref } : {}),
          error: ingested.completed.error ?? null,
          completedAt: new Date().toISOString(),
        };
        extra.push({ type: "attempt.changed", attempt });
      }
      await log.append(trx, { sessionId: input.turn.sessionId, events: [...ingested.events, ...extra] });
      if (ingested.statePath)
        await trx
          .updateTable("agent_provider_threads")
          .set({ state_path: ingested.statePath })
          .where("id", "=", ingested.thread.id)
          .execute();
      // Steers refused by the harness are restarted, not acknowledged.
      const acknowledged = acked.filter((id) => !refusedSteers.includes(id));
      await queue.markCommands({ ids: acknowledged, status: "acknowledged", executor: trx });
      await trx
        .updateTable("agent_turn_attempts")
        .set({ runner: unanswered(local, attempt.id, runner) as unknown as Json })
        .where("id", "=", attempt.id)
        .execute();
      return {
        turn,
        attempt,
        thread: ingested.thread,
        runner,
        calls,
        refusedSteers,
        ...(ingested.completed ? { completion: ingested.completed } : {}),
      };
    });
  }

  private async saveRunner(local: LocalTurn, attemptId: string, runner: RunnerState): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      await trx
        .updateTable("agent_turn_attempts")
        .set({ runner: unanswered(local, attemptId, runner) as unknown as Json })
        .where("id", "=", attemptId)
        .execute();
    });
  }

  /**
   * Answer host calls. Native state is Postgres-only, so it is answered in
   * one transaction with forgetting the call: never applied twice. A host
   * tool runs outside it; one found taken after a takeover is answered
   * with the uncertainty, never run twice (ADR 0196).
   */
  private async answerCalls(
    local: LocalTurn,
    ctx: { identity: Identity; session: SessionRow; turn: Turn; attempt: Attempt },
    channel: RunnerChannel,
    runner: RunnerState,
    calls: ReadonlyArray<[string, HostCall]>,
    /** Answering what an earlier holder took: a tool it may have run is not run again. */
    takeover: boolean,
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
            await this.native.append({ threadId, ...(call.subpath ? { subpath: call.subpath } : {}), entries: call.entries, executor: trx });
            await this.forgetCall(trx, ctx.attempt.id, callId);
          });
          local.answered.add(`${ctx.attempt.id}:${callId}`);
          result = null;
        } else if (call.kind === "native_state.load") {
          result = (await this.native.load({ threadId, ...(call.subpath ? { subpath: call.subpath } : {}) })) ?? null;
        } else if (call.kind === "native_state.subpaths") {
          result = await this.native.subpaths({ threadId });
        } else if (takeover) {
          error =
            "The machine running this turn stopped while this tool ran. It may or may not have completed: check its effects before trying again.";
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
      await channel.send([
        {
          id: `result:${ctx.attempt.id}:${callId}`,
          command: {
            kind: "host_result",
            callId,
            ...(error === undefined ? { result: result ?? null } : { error: { message: error } }),
          },
        },
      ]);
      if (call.kind !== "native_state.append") {
        await this.deps.db.transaction().execute(async (trx) => {
          await this.assertOwned(local, trx);
          await this.forgetCall(trx, ctx.attempt.id, callId);
        });
        local.answered.add(`${ctx.attempt.id}:${callId}`);
      }
    }
  }

  private async forgetCall(trx: Transaction<DB>, attemptId: string, callId: string): Promise<void> {
    await trx
      .updateTable("agent_turn_attempts")
      .set({ runner: sql`runner #- ${`{calls,${callId}}`}::text[]` })
      .where("id", "=", attemptId)
      .execute();
  }

  /** A native state call's thread: the attempt's, or a fork's source. */
  private async threadForCall(attempt: Attempt, call: HostCall): Promise<string> {
    const own = attempt.providerThreadId;
    if (!own) throw new Error("The attempt has no provider thread");
    if (call.kind === "tool" || !call.thread) return own;
    const rows = await this.deps.db
      .selectFrom("agent_provider_threads")
      .select(["id", "native_ref", "fork_source"])
      .where("session_id", "=", attempt.sessionId)
      .execute();
    const match = rows.find(
      (row) => (row.native_ref as unknown as NativeRef | null)?.id === call.thread,
    );
    if (match) return match.id;
    // A fork reads its source thread, which belongs to the source session.
    const ownRow = rows.find((row) => row.id === own);
    const source = (ownRow?.fork_source as unknown as { threadId?: string; source?: NativeRef } | null) ?? null;
    if (source?.threadId && source.source?.id === call.thread) return source.threadId;
    return own;
  }

  private async stopRunner(local: LocalTurn, channel: RunnerChannel | undefined): Promise<void> {
    if (!channel) return;
    // A runner on a sandbox that outlives this holder is left for the next.
    if (local.handingBack) return;
    await channel.send([{ id: `stop:${randomUUID()}`, command: { kind: "stop" } }]).catch(() => {});
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
      completion: { status: "completed" | "failed" | "interrupted"; error?: TurnError };
    },
  ): Promise<void> {
    const { db, log } = this.deps;
    let turn: Turn = ctx.turn;
    if (turn.status !== "finalizing") {
      turn = { ...turn, status: "finalizing", activity: "Saving changes", activityAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await db.transaction().execute(async (trx) => {
        await this.assertOwned(local, trx);
        await log.append(trx, { sessionId: turn.sessionId, events: [{ type: "turn.changed", turn }] });
      });
    }
    const inputItem = turn.inputItemId
      ? await db.selectFrom("agent_items").select("payload").where("id", "=", turn.inputItemId).executeTakeFirst()
      : undefined;
    const inputText = inputItem ? itemText(itemFromRow(inputItem)) : CONTINUATION_PROMPT;
    const finalized = await this.deps.host.finalize({
      identity: ctx.identity,
      session: ctx.session,
      turn,
      inputText,
      completion: { status: ctx.completion.status },
    });
    const status = finalized.failure
      ? "failed"
      : ctx.completion.status;
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
    const transient =
      input.status === "failed" &&
      input.error?.retrySafe === true &&
      (input.error.kind === "rate_limit" || input.error.kind === "unavailable") &&
      input.turn.attemptCount < MAX_TRANSIENT_RETRIES;
    const delay = BACKOFF_MS[Math.min(input.turn.attemptCount - 1, BACKOFF_MS.length - 1)] ?? 60_000;
    const retryAt = transient
      ? new Date(Date.now() + delay + Math.floor(Math.random() * delay * 0.2))
      : null;
    const settled: Turn = {
      ...input.turn,
      status: transient ? "queued" : input.status,
      activity: null,
      activityAt: null,
      cancellationRequested: false,
      error: input.status === "completed" ? null : (input.error ?? null),
      outcome: input.outcome,
      checkpoint: { ...input.turn.checkpoint, after: input.checkpointAfter ?? input.turn.checkpoint.after },
      retryAt: retryAt?.toISOString() ?? null,
      completedAt: transient ? null : now,
      updatedAt: now,
    };
    let reply: Item | null = null;
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      const events: SessionEvent[] = [];
      if (input.attempt.status === "preparing" || input.attempt.status === "running")
        events.push({
          type: "attempt.changed",
          attempt: { ...input.attempt, status: input.status === "completed" ? "completed" : input.status === "interrupted" ? "interrupted" : "failed", completedAt: now, error: input.error ?? null },
        });
      // Whatever the attempt left open closes with the turn.
      events.push(...(await closeOpenWork(trx, { turn: input.turn, attemptId: input.attempt.id, reason: "The turn ended before it was answered.", now })));
      events.push({ type: "turn.changed", turn: settled });
      if (!transient) events.push(...(await this.requeueSteers(trx, input.turn, now)));
      if (input.attempt.providerThreadId && input.status !== "failed") {
        const threadRow = await trx
          .selectFrom("agent_provider_threads")
          .selectAll()
          .where("id", "=", input.attempt.providerThreadId)
          .executeTakeFirst();
        if (threadRow)
          events.push({
            type: "provider_thread.changed",
            thread: { ...providerThreadFromRow(threadRow), lastTurnOrdinal: input.turn.ordinal, updatedAt: now },
          });
      }
      const needsAttention =
        (input.status === "failed" && !transient) || input.outcome.notification !== undefined;
      if (needsAttention)
        events.push({
          type: "session.changed",
          session: { attentionRevision: Number(input.session.attention_revision) + 1 },
        });
      if (input.session.title === null && input.turn.inputItemId) {
        const row = await trx.selectFrom("agent_items").select("payload").where("id", "=", input.turn.inputItemId).executeTakeFirst();
        const item = row ? itemFromRow(row) : null;
        if (item?.kind === "user_message")
          events.push({ type: "session.changed", session: { title: titleFrom(item) } });
      }
      await log.append(trx, { sessionId: input.turn.sessionId, events });
      await queue.markCommands({
        ids: (await queue.openCommands({ turnId: input.turn.id, executor: trx })).map((command) => command.id),
        status: "dropped",
        executor: trx,
      });
      if (retryAt) await queue.scheduleRetry(trx, { turnId: input.turn.id, at: retryAt });
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
      .catch((error) => console.warn("[catamorphic] After-turn work failed", error));
  }

  /**
   * An attempt whose runner is gone (ADR 0196): it is lost, its turn is
   * interrupted with the reason, open requests can no longer be answered,
   * and a continuation is queued once when the agent recovers by
   * continuing and its native thread can be resumed exactly.
   */
  private async lose(
    local: LocalTurn,
    ctx: { identity: Identity; session: SessionRow; turn: Turn; attempt: Attempt; reason: string },
  ): Promise<void> {
    const { db, log, queue } = this.deps;
    const now = new Date().toISOString();
    const harness = await this.deps.host
      .harnessOf({ identity: ctx.identity, session: ctx.session })
      .catch(() => ({ harness: "", agentId: null, recovery: "stop" as const }));
    let continued = false;
    await db.transaction().execute(async (trx) => {
      await this.assertOwned(local, trx);
      const events: SessionEvent[] = [
        { type: "attempt.changed", attempt: { ...ctx.attempt, status: "lost", completedAt: now, error: { message: ctx.reason } } },
        ...(await closeOpenWork(trx, { turn: ctx.turn, attemptId: ctx.attempt.id, reason: "The agent that asked stopped before it was answered.", now })),
        {
          type: "turn.changed",
          turn: {
            ...ctx.turn,
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
      const requeued = await this.requeueSteers(trx, ctx.turn, now);
      events.push(...requeued);
      const thread = ctx.attempt.providerThreadId
        ? await trx.selectFrom("agent_provider_threads").selectAll().where("id", "=", ctx.attempt.providerThreadId).executeTakeFirst()
        : undefined;
      const strong = (thread?.native_ref as unknown as NativeRef | null)?.strength === "strong";
      // The thread took this turn's input before its runner went away: a
      // continuation on it is not handed the turn again.
      if (thread)
        events.push({
          type: "provider_thread.changed",
          thread: { ...providerThreadFromRow(thread), lastTurnOrdinal: ctx.turn.ordinal, updatedAt: now },
        });
      const newer = await trx
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", ctx.turn.sessionId)
        .where("ordinal", ">", ctx.turn.ordinal)
        .executeTakeFirst();
      const alreadyContinued = await trx
        .selectFrom("agent_turns")
        .select("id")
        .where("continuation_of", "=", ctx.turn.id)
        .executeTakeFirst();
      if (
        harness.recovery === "continue" &&
        strong &&
        !newer &&
        requeued.length === 0 &&
        !alreadyContinued &&
        !ctx.turn.cancellationRequested &&
        ctx.session.status === "active"
      ) {
        const noticeId = derivedId(ctx.turn.id, "continued");
        const ordinal = ctx.turn.ordinal + 1;
        const turnId = derivedId(ctx.turn.id, "continuation");
        events.push(
          {
            type: "item.added",
            item: {
              id: noticeId,
              sessionId: ctx.turn.sessionId,
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
              data: { continuationOf: ctx.turn.id },
            },
          },
          {
            type: "turn.changed",
            turn: {
              id: turnId,
              sessionId: ctx.turn.sessionId,
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
              continuationOf: ctx.turn.id,
              createdAt: now,
              startedAt: null,
              completedAt: null,
              updatedAt: now,
            },
          },
        );
        continued = true;
      }
      await log.append(trx, { sessionId: ctx.turn.sessionId, commandId: `continue:${ctx.turn.id}`, events });
      await queue.markCommands({
        ids: (await queue.openCommands({ turnId: ctx.turn.id, executor: trx })).map((command) => command.id),
        status: "dropped",
        executor: trx,
      });
      await queue.release(trx, { turnId: ctx.turn.id });
    });
    if (local.channel) await local.channel.kill().catch(() => {});
    await this.deps.host
      .settled({
        identity: ctx.identity,
        session: ctx.session,
        turn: { ...ctx.turn, status: "interrupted", error: { message: ctx.reason } },
        reply: null,
        retrying: continued,
      })
      .catch((error) => console.warn("[catamorphic] After-turn work failed", error));
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
      .where("kind", "=", "user_message")
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
  private async requeueSteers(trx: Transaction<DB>, turn: Turn, now: string): Promise<SessionEvent[]> {
    const steered = await this.steeredItemIds(turn, trx);
    if (steered.length === 0) return [];
    const attempts = await trx
      .selectFrom("agent_turn_attempts")
      .select("runner")
      .where("turn_id", "=", turn.id)
      .execute();
    const consumed = new Set(
      attempts.flatMap((row) => ((row.runner as unknown as RunnerState | null)?.consumed ?? [])),
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
    for (const itemId of pending) {
      const row = await trx.selectFrom("agent_items").select("payload").where("id", "=", itemId).executeTakeFirst();
      if (!row) continue;
      const item = itemFromRow(row);
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
      events.push(
        { type: "turn.changed", turn: next },
        { type: "item.changed", item: { ...item, turnId: next.id, updatedAt: now } as Item },
      );
    }
    return events;
  }

  /** A failure outside the protocol (preparation threw): the turn fails, saying why. */
  private async failUnexpectedly(local: LocalTurn, error: unknown): Promise<void> {
    const turn = await this.loadTurn(local.claim.turn.id);
    if (!["preparing", "running", "waiting", "finalizing"].includes(turn.status)) return;
    const session = await this.deps.db
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", turn.sessionId)
      .executeTakeFirstOrThrow();
    const identity = await this.deps.host.owner(session);
    if (!identity) return;
    const attemptRow = turn.activeAttemptId
      ? await this.deps.db.selectFrom("agent_turn_attempts").selectAll().where("id", "=", turn.activeAttemptId).executeTakeFirst()
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
      error: { message: error instanceof Error ? error.message : String(error) },
      outcome: turn.outcome ?? { changedFiles: [] },
      checkpointAfter: null,
    });
  }

  private async assertOwned(local: LocalTurn, trx: Transaction<DB>): Promise<void> {
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

/** This process no longer holds the turn: another took it over. */
export class TurnLeaseLostError extends Error {
  constructor(readonly turnId: string) {
    super("Execution ownership was lost. Another machine continues this turn.");
    this.name = "TurnLeaseLostError";
  }
}

const QUEUED_COMMAND_KINDS: ReadonlySet<string> = new Set<TurnCommandKind>([
  "steer",
  "interrupt",
  "respond",
  "stop",
]);

function splitCommandId(id: string): [string, string | undefined] {
  const index = id.indexOf(":");
  return index < 0 ? [id, undefined] : [id.slice(0, index), id.slice(index + 1)];
}

function attemptOutcome(attempt: Attempt): "completed" | "failed" | "interrupted" {
  return attempt.status === "completed"
    ? "completed"
    : attempt.status === "interrupted" || attempt.status === "superseded" || attempt.status === "lost"
      ? "interrupted"
      : "failed";
}

function itemText(item: Item): string {
  return item.kind === "user_message" || item.kind === "notice" ? item.text : "";
}

function titleFrom(item: Extract<Item, { kind: "user_message" }>): string {
  const names = item.attachments.map((attachment) => attachment.name).filter(Boolean);
  const text = item.text.replace(/\s+/g, " ").trim() || names.join(", ");
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
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
  const items = await trx
    .selectFrom("agent_items")
    .select("payload")
    .where("turn_id", "=", input.turn.id)
    .where("status", "=", "in_progress")
    .execute();
  for (const row of items) {
    const item = itemFromRow(row);
    events.push({
      type: "item.changed",
      item: { ...item, status: "cancelled", endedAt: input.now, updatedAt: input.now } as Item,
    });
  }
  const requests = await trx
    .selectFrom("agent_runtime_requests")
    .selectAll()
    .where("session_id", "=", input.turn.sessionId)
    .where("turn_id", "=", input.turn.id)
    .where("status", "=", "pending")
    .execute();
  for (const row of requests) {
    const request: RuntimeRequest = requestFromRow(row);
    // A non-blocking question outlives its turn: its answer becomes a message.
    if (!request.blocking && request.kind === "question") continue;
    events.push({
      type: "request.changed",
      request: { ...request, status: "expired", answerable: false, reason: input.reason, resolvedAt: input.now },
    });
  }
  return events;
}

export type { JsonObject };
