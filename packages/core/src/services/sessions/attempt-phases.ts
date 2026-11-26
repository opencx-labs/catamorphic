import { type DB, type Json, jsonbText } from "@catamorphic/db";
import { type Kysely, type RawBuilder, sql } from "kysely";

/*
 * How long each part of an attempt's preparation took (ADR 0354). An
 * attempt keeps an ordered list of `{ phase, startedAt, endedAt }`
 * (`agent_turn_attempts.phases`), written as each phase starts and as it
 * ends, so a preparation that is stuck shows which phase it is in, and the
 * list stays with the attempt after its turn settled. A phase still running
 * has no `endedAt`. Time between phases is Work's own preparation: grants,
 * secrets, the member's files. OpenTelemetry spans cover the same work for
 * the host's operators; these are for the project.
 */

/**
 * Every phase an attempt may record, in the order a first attempt meets
 * them. The names are part of the read contract: workflows compare them.
 */
export const ATTEMPT_PHASES = [
  /** The chat waited for a machine (ADR 0258), until it was placed. */
  "machine.wait",
  /** Another chat's turn was making or setting up the workspace they share (ADR 0322). */
  "workspace.wait",
  /** Making the workspace's sandbox, pulling or building its image included. */
  "sandbox.create",
  /** Starting a sandbox that was stopped. */
  "sandbox.start",
  /** Bringing the workspace's base commit into the sandbox (ADR 0353). */
  "workspace.checkout",
  /** Bringing the chat's saved work: its branch, commits and uncommitted changes. */
  "workspace.restore",
  /** The Environment's setup command (ADR 0208), on its own network or not. */
  "setup.environment",
  /** The Environment's setup workflow (ADR 0324). */
  "setup.workflow",
  /** The member's own setup command. */
  "setup.personal",
  /** Starting the runner and its harness, until the harness has its start. */
  "harness.start",
  /** From there to the agent's first output: its first item, or its end. */
  "harness.first-output",
] as const;

export type AttemptPhaseName = (typeof ATTEMPT_PHASES)[number];

/** One phase of an attempt, as it is read. */
export interface AttemptPhase {
  phase: AttemptPhaseName;
  /** ISO timestamps; `endedAt` is null while the phase runs. */
  startedAt: string;
  endedAt: string | null;
}

/** Times work as a phase. Preparation outside an attempt times nothing. */
export interface PhaseTimer {
  /** Run `work` as `phase`: recorded when it starts, ended however it ends. */
  run<T>(phase: AttemptPhaseName, work: () => Promise<T>): Promise<T>;
  /** Start `phase` now. The function it answers with ends it. */
  start(phase: AttemptPhaseName): Promise<() => Promise<void>>;
}

/** What preparation that belongs to no attempt is timed with. */
export const UNTIMED: PhaseTimer = {
  run: (_phase, work) => work(),
  start: async () => async () => {},
};

/** The phases column, in a statement that updates `agent_turn_attempts`. */
const STORED = sql<Json>`phases`;

/**
 * `from` (the stored phases by default) with its phases that still run
 * ended at `at`: those named `phase`, or all of them.
 */
export function phasesEnded(input: {
  at: string;
  phase?: AttemptPhaseName;
  from?: RawBuilder<Json>;
}): RawBuilder<Json> {
  const runs = input.phase
    ? sql<boolean>`entry.value->>'endedAt' IS NULL AND entry.value->>'phase' = ${input.phase}`
    : sql<boolean>`entry.value->>'endedAt' IS NULL`;
  return sql<Json>`(SELECT coalesce(jsonb_agg(CASE WHEN ${runs} THEN entry.value || jsonb_build_object('endedAt', ${input.at}::text) ELSE entry.value END ORDER BY entry.position), '[]'::jsonb) FROM jsonb_array_elements(${input.from ?? STORED}) WITH ORDINALITY AS entry(value, position))`;
}

/** `from` (the stored phases by default) with `phase` added, started at `at`. */
export function phasesStarted(input: {
  phase: AttemptPhaseName;
  at: string;
  /** For a phase that ended before it could be recorded. */
  endedAt?: string;
  from?: RawBuilder<Json>;
}): RawBuilder<Json> {
  const entry = {
    phase: input.phase,
    startedAt: input.at,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
  };
  return sql<Json>`${input.from ?? STORED} || jsonb_build_array(${jsonbText(entry)}::jsonb)`;
}

function isPhaseName(value: unknown): value is AttemptPhaseName {
  return ATTEMPT_PHASES.some((phase) => phase === value);
}

/**
 * The phases an attempt row holds, as they are read. One the attempt left
 * running when it ended reads as ended then: nothing of an attempt runs
 * after it.
 */
export function attemptPhases(input: {
  phases: unknown;
  completedAt: string | null;
}): AttemptPhase[] {
  if (!Array.isArray(input.phases)) return [];
  return input.phases.flatMap((entry: unknown): AttemptPhase[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const phase = "phase" in entry ? entry.phase : undefined;
    const startedAt = "startedAt" in entry ? entry.startedAt : undefined;
    const endedAt = "endedAt" in entry ? entry.endedAt : undefined;
    if (!isPhaseName(phase) || typeof startedAt !== "string") return [];
    return [
      {
        phase,
        startedAt,
        endedAt: typeof endedAt === "string" ? endedAt : input.completedAt,
      },
    ];
  });
}

/**
 * One attempt's phases, written as its preparation goes. Recording never
 * fails a turn: a write that fails is logged and the work goes on.
 */
export class AttemptPhases implements PhaseTimer {
  constructor(private readonly deps: { db: Kysely<DB>; attemptId: string }) {}

  /**
   * Begin recording a preparation. Phases an earlier preparation of the
   * same attempt left running (its holder stopped) end here, and the wait
   * for a machine that ended with `allocationId` becomes the attempt's
   * `machine.wait`, taken once: a later attempt on the same Allocation
   * waited for no machine.
   */
  async begin(input: { allocationId?: string | null }): Promise<void> {
    const { db, attemptId } = this.deps;
    await db
      .transaction()
      .execute(async (trx) => {
        const waited = input.allocationId
          ? await trx
              .selectFrom("execution_allocations")
              .select(["waited_since", "created_at"])
              .where("id", "=", input.allocationId)
              .where("waited_since", "is not", null)
              .forUpdate()
              .executeTakeFirst()
          : undefined;
        const since = waited?.waited_since?.toISOString();
        // The machine it ran on was lost while it prepared: what it left
        // running ended before it waited for another.
        const ended = phasesEnded({ at: since ?? new Date().toISOString() });
        await trx
          .updateTable("agent_turn_attempts")
          .set({
            phases:
              waited && since
                ? phasesStarted({
                    from: ended,
                    phase: "machine.wait",
                    at: since,
                    endedAt: waited.created_at.toISOString(),
                  })
                : ended,
          })
          .where("id", "=", attemptId)
          .execute();
        if (waited && input.allocationId)
          await trx
            .updateTable("execution_allocations")
            .set({ waited_since: null })
            .where("id", "=", input.allocationId)
            .execute();
      })
      .catch(unrecorded);
  }

  async start(phase: AttemptPhaseName): Promise<() => Promise<void>> {
    const { db, attemptId } = this.deps;
    await db
      .updateTable("agent_turn_attempts")
      .set({ phases: phasesStarted({ phase, at: new Date().toISOString() }) })
      .where("id", "=", attemptId)
      .execute()
      .catch(unrecorded);
    return async () => {
      await db
        .updateTable("agent_turn_attempts")
        .set({ phases: phasesEnded({ phase, at: new Date().toISOString() }) })
        .where("id", "=", attemptId)
        .execute()
        .catch(unrecorded);
    };
  }

  async run<T>(phase: AttemptPhaseName, work: () => Promise<T>): Promise<T> {
    const end = await this.start(phase);
    try {
      return await work();
    } finally {
      await end();
    }
  }
}

function unrecorded(error: unknown): void {
  console.warn("[catamorphic] Could not record an attempt's phase", error);
}
