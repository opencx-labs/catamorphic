import {
  type BoundaryContext,
  type Carried,
  defineWorkflow,
  type SessionSnapshot,
  type SessionTurnAttempt,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

/*
 * Optional (ADR 0333): a review turn that stops making progress for the
 * reviewer's `stall.minutes` has its evidence kept and is restarted, at most
 * MAX_RESTARTS times a turn. The evidence is Work's own record of the
 * attempt (its runner's and harness's output, masked), never a command run
 * in the review's workspace: the pull request's code runs there, and
 * commands may run apart from the agent, where they see neither. After that the turn is stopped, and
 * `postReviews` marks the commit as having no review, as for a failed turn.
 * Work only reports the stall; what to do is this workflow's choice.
 */

/** Restarts of one review turn before it is stopped instead. */
const MAX_RESTARTS = 2;

/** The repository this project reviews, as `owner/name` (as in reviews.ts). */
const REVIEWED_REPOSITORY = "acme/web";

/** Where each stall's evidence is kept, per pull request number. */
const STALLS_PATH = "store/reviews/stalls";

/** One stall, carried from call to call. */
type Stall = {
  sessionId: string;
  key: string;
  /** The pull request's number, from the chat's key; 0 when not ours. */
  number: number;
  turnId: string;
  attemptId: string;
  attempt: number;
  restarts: number;
  stallMinutes: number;
  progressAt: string | null;
  /** What the attempt reported still running when it stalled. */
  activity: string[];
  /**
   * restart, stop (the bound is reached), or nothing (not this
   * repository's review chat, or the turn moved on).
   */
  act: "restart" | "stop" | "nothing";
  attempts: SessionTurnAttempt[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The pull request a review chat's key names, exactly: 0 for any other. */
function pullRequestOf(key: string): number {
  // pr-acme/web-tools-3 is not acme/web.
  const prefix = `pr-${REVIEWED_REPOSITORY}-`;
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  const number = /^[1-9]\d*$/.test(rest) ? Number(rest) : 0;
  return Number.isSafeInteger(number) ? number : 0;
}

/** The reviewer's project chat in `review` that reviewPullRequests started. */
function ours(chat: SessionSnapshot): boolean {
  return (
    chat.owner === "project" &&
    chat.agentId === `project:${chat.projectId}:reviewer` &&
    chat.placement?.environment === "review" &&
    chat.keyWorkflows.includes("reviewPullRequests")
  );
}

/** Whether the chat's turn is still the attempt that stalled, still silent. */
function stillStalled(chat: SessionSnapshot, stall: Stall): boolean {
  const turn = chat.turn;
  return (
    turn?.id === stall.turnId &&
    turn.attempt?.id === stall.attemptId &&
    turn.stalledAt !== null &&
    turn.stalledAt !== undefined
  );
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
  // `restart` and `interrupt` act on the project's review chat.
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
        const key = event.session.key ?? "";
        const number = pullRequestOf(key);
        const stall: Stall = {
          sessionId: event.sessionId,
          key,
          number,
          turnId: text(detail.turnId),
          attemptId: text(detail.attemptId),
          attempt: count(detail.attempt),
          restarts: count(detail.restarts),
          stallMinutes: count(detail.stallMinutes),
          progressAt: text(detail.progressAt) || null,
          activity: activityOf(detail.activity),
          act:
            number === 0
              ? "nothing"
              : count(detail.restarts) < MAX_RESTARTS
                ? "restart"
                : "stop",
          attempts: [],
        };
        return host["catamorphic.sessions"].inspect(
          { sessionId: stall.sessionId },
          { state: stall },
        );
      },
    }),
    /** @displayname Read the attempts' own output */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<Carried<SessionSnapshot, Stall>>) => {
        // Only this repository's review chat, and only the attempt that
        // stalled while it is still silent: one that moved on, or was
        // restarted already, is left alone.
        const stall: Stall =
          ours(input.result) && stillStalled(input.result, input.state)
            ? input.state
            : { ...input.state, act: "nothing" };
        if (stall.act === "nothing") return { result: null, state: stall };
        // What Work recorded of each attempt, masked: nothing the pull
        // request's code can write.
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
        // One folder per pull request number: the repository is this one.
        return documents.write(
          {
            path: `${STALLS_PATH}/${stall.number}/${stall.attemptId}.json`,
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
    /** @displayname Read the chat again */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<Carried<unknown, Stall>>) => {
        const stall = input.state;
        if (stall.act === "nothing") return { result: null, state: stall };
        // Act only on what the chat is now.
        return host["catamorphic.sessions"].inspect(
          { sessionId: stall.sessionId },
          { state: stall },
        );
      },
    }),
    /** @displayname Restart the turn, or stop it */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<Carried<SessionSnapshot | null, Stall>>) => {
        const stall: Stall =
          input.result && stillStalled(input.result, input.state)
            ? input.state
            : { ...input.state, act: "nothing" };
        if (stall.act === "nothing") return { result: null, state: stall };
        // Past the bound this turn stops, and only this turn: it settles
        // interrupted, and postReviews marks the commit as having no review.
        if (stall.act === "stop")
          return host["catamorphic.sessions"].interrupt(
            {
              sessionId: stall.sessionId,
              turnId: stall.turnId,
              idempotencyKey: `stall:${stall.turnId}:stop`,
            },
            { state: stall },
          );
        const waiting = stall.activity.length
          ? ` while running ${stall.activity.slice(0, 3).join(", ")}`
          : "";
        // Only the attempt that stalled, and only while it still is.
        return host["catamorphic.sessions"].restart(
          {
            sessionId: stall.sessionId,
            turnId: stall.turnId,
            attemptId: stall.attemptId,
            onlyIfStalled: true,
            reason: `no progress for ${stall.stallMinutes} minutes${waiting}`,
            idempotencyKey: `stall:${stall.attemptId}`,
          },
          { state: stall },
        );
      },
    }),
    /** @displayname Report */
    defineBoundary({
      run: ({ input }: BoundaryContext<Carried<unknown, Stall>>) => {
        const result: unknown = input.result;
        const said = (field: string) =>
          result !== null &&
          typeof result === "object" &&
          Reflect.get(result, field) === true;
        // A refused restart, or a stop that found the turn gone: nothing.
        const acted =
          input.state.act === "restart"
            ? said("restarted")
            : input.state.act === "stop"
              ? said("interrupted")
              : false;
        return {
          key: input.state.key,
          turnId: input.state.turnId,
          attempt: input.state.attempt,
          act: acted ? input.state.act : "nothing",
        };
      },
    }),
  ],
}));
