import {
  type BoundaryContext,
  type Carried,
  defineWorkflow,
  type SessionExecResult,
  type SessionSnapshot,
  type SessionTurnAttempt,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

/*
 * Optional (ADR 0333): a review turn that stops making progress for the
 * reviewer's `stall.minutes` is diagnosed and restarted, at most
 * MAX_RESTARTS times a turn. After that the turn is stopped, and
 * `postReviews` marks the commit as having no review, as for a failed turn.
 * Work only reports the stall; what to do is this workflow's choice.
 */

/** Restarts of one review turn before it is stopped instead. */
const MAX_RESTARTS = 2;

/** Where each stall's evidence is kept, per pull request chat. */
const STALLS_PATH = "store/reviews/stalls";

/**
 * What the sandbox shows of a hung agent: its processes and the newest log
 * of a harness that keeps one there. Missing directories are skipped.
 */
const DIAGNOSE = [
  "echo '== processes'",
  "ps -eo pid,ppid,etime,stat,args 2>/dev/null | head -n 200",
  "echo '== harness logs'",
  'for dir in "$HOME/.local/share/opencode/log" "$HOME/.codex/log" "$HOME/.claude/debug"; do',
  '  [ -d "$dir" ] || continue',
  '  newest=$(ls -t "$dir" 2>/dev/null | head -n 1)',
  '  [ -n "$newest" ] && { echo "-- $dir/$newest"; tail -n 200 "$dir/$newest"; }',
  "done",
].join("\n");

/** One stall, carried from call to call. */
type Stall = {
  sessionId: string;
  key: string;
  turnId: string;
  attemptId: string;
  attempt: number;
  restarts: number;
  stallMinutes: number;
  progressAt: string | null;
  /** What the attempt reported still running when it stalled. */
  activity: string[];
  /** restart, stop (the bound is reached), or nothing (it moved on). */
  act: "restart" | "stop" | "nothing";
  processes: SessionExecResult | null;
  attempts: SessionTurnAttempt[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The tool calls and commands a stall event says were still running. */
function activityOf(value: unknown): string[] {
  const activity =
    value && typeof value === "object"
      ? (value as { tools?: unknown; commands?: unknown })
      : {};
  const entries = (list: unknown, field: string) =>
    (Array.isArray(list) ? list : []).flatMap((entry) => {
      const named =
        entry && typeof entry === "object"
          ? text((entry as Record<string, unknown>)[field])
          : "";
      return named ? [named.slice(0, 200)] : [];
    });
  return [
    ...entries(activity.tools, "name"),
    ...entries(activity.commands, "command"),
  ];
}

/** @displayname Restart stalled reviews */
export const restartStalledReviews = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("session.turn-stalled", {
      where: { payload: { session: { key: { $prefix: "pr-acme/web-" } } } },
    }),
  ],
  // A chat's stalls are handled one at a time, in order.
  concurrency: { key: "payload.session.key", onConflict: "queue" },
  // `exec` and `restart` act on the project's review chat (ADR 0324).
  permissions: ["sessions:write"],
  steps: [
    /** @displayname Read the review chat */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<TriggerPayload<"session.turn-stalled">>) => {
        const event = input.payload;
        const detail = event.detail;
        const stall: Stall = {
          sessionId: event.sessionId,
          key: event.session.key ?? "",
          turnId: text(detail.turnId),
          attemptId: text(detail.attemptId),
          attempt: count(detail.attempt),
          restarts: count(detail.restarts),
          stallMinutes: count(detail.stallMinutes),
          progressAt: text(detail.progressAt) || null,
          activity: activityOf(detail.activity),
          act: count(detail.restarts) < MAX_RESTARTS ? "restart" : "stop",
          processes: null,
          attempts: [],
        };
        return host["catamorphic.sessions"].inspect(
          { sessionId: stall.sessionId },
          { state: stall },
        );
      },
    }),
    /** @displayname Collect what the sandbox shows */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<Carried<SessionSnapshot, Stall>>) => {
        const turn = input.result.turn;
        // Only the attempt that stalled, while it is still silent: one that
        // moved on, or was restarted already, is left alone.
        const still =
          turn?.id === input.state.turnId &&
          turn.attempt?.id === input.state.attemptId &&
          turn.stalledAt !== null;
        const stall: Stall = still
          ? input.state
          : { ...input.state, act: "nothing" };
        if (stall.act === "nothing") return { result: null, state: stall };
        return host["catamorphic.sessions"].exec(
          {
            sessionId: stall.sessionId,
            command: DIAGNOSE,
            in: "session",
            timeoutSeconds: 60,
            idempotencyKey: `stall:${stall.attemptId}:diagnose`,
          },
          { state: stall },
        );
      },
    }),
    /** @displayname Read the attempts' own output */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<Carried<SessionExecResult | null, Stall>>) => {
        const stall: Stall = { ...input.state, processes: input.result };
        if (stall.act === "nothing") return { result: null, state: stall };
        return host["catamorphic.sessions"].attempts(
          { sessionId: stall.sessionId, turnId: stall.turnId },
          { state: stall },
        );
      },
    }),
    /** @displayname Keep the evidence */
    defineBoundary({
      run: ({
        input,
        documents,
      }: BoundaryContext<
        Carried<{ attempts: SessionTurnAttempt[] } | null, Stall>
      >) => {
        const stall: Stall = {
          ...input.state,
          attempts: input.result?.attempts ?? [],
        };
        if (stall.act === "nothing") return { result: null, state: stall };
        const chat = stall.key.replace(/^pr-/, "").replace(/[^\w.-]+/g, "-");
        return documents.write(
          {
            path: `${STALLS_PATH}/${chat}/${stall.attemptId}.json`,
            contentType: "application/json",
            text: JSON.stringify(
              {
                key: stall.key,
                turnId: stall.turnId,
                attemptId: stall.attemptId,
                attempt: stall.attempt,
                restarts: stall.restarts,
                stallMinutes: stall.stallMinutes,
                progressAt: stall.progressAt,
                activity: stall.activity,
                act: stall.act,
                processes: stall.processes,
                attempts: stall.attempts,
              },
              null,
              2,
            ),
          },
          { state: stall },
        );
      },
    }),
    /** @displayname Restart the turn, or stop it */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<Carried<unknown, Stall>>) => {
        const stall = input.state;
        if (stall.act === "nothing") return { result: null, state: stall };
        // Past the bound the turn stops: it settles interrupted, and
        // postReviews marks the commit as having no review.
        if (stall.act === "stop")
          return host["catamorphic.sessions"].interrupt(
            {
              sessionId: stall.sessionId,
              idempotencyKey: `stall:${stall.turnId}:stop`,
            },
            { state: stall },
          );
        const waiting = stall.activity.length
          ? ` while running ${stall.activity.slice(0, 3).join(", ")}`
          : "";
        return host["catamorphic.sessions"].restart(
          {
            sessionId: stall.sessionId,
            turnId: stall.turnId,
            reason: `no progress for ${stall.stallMinutes} minutes${waiting}`,
            idempotencyKey: `stall:${stall.attemptId}`,
          },
          { state: stall },
        );
      },
    }),
    /** @displayname Report */
    defineBoundary({
      run: ({ input }: BoundaryContext<Carried<unknown, Stall>>) => ({
        key: input.state.key,
        turnId: input.state.turnId,
        attempt: input.state.attempt,
        act: input.state.act,
      }),
    }),
  ],
}));
