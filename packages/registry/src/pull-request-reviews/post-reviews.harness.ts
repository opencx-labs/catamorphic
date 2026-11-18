/*
 * Test harness for `postReviews` (not installed by the pack). It runs the
 * shipped workflow's boundaries the way Work does: each boundary returns one
 * call, the call's result (with its carried state) is the next boundary's
 * input, and a failed boundary is tried again from its own input. Runs of
 * one key take turns, by the workflow's declared `concurrency`, and the
 * fake GitHub finds a stamped write again as the typed actions do.
 */

type Json = unknown;
type Call = { __call: () => Promise<Json>; state?: Json };

export interface FakeReview {
  verdict: "COMMENT" | "REQUEST_CHANGES";
  reviewedCommit: string;
  reply?: { inReplyTo?: number; body: string } | null;
  /** The ids of the turn's findings it stands behind. */
  findings?: string[];
  /** The attempt that submitted it; the turn may have later attempts. */
  attemptId?: string;
  /** The commit Work recorded the turn began on; the chat's commit when absent. */
  turnCommit?: string | null;
}

export interface FakeFinding {
  id: string;
  path?: string;
  line?: number;
  startLine?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  severity?: "blocking" | "important" | "minor";
  title?: string;
  body?: string;
  attemptId?: string;
  turnCommit?: string | null;
}

export function fakeWorld(input: { head: string }) {
  let nextId = 100;
  const github = {
    head: input.head,
    state: "open",
    checks: [] as Array<{
      id: number;
      own: boolean;
      status: string;
      conclusion: string | null;
      externalId: string | null;
      headSha: string;
      title: string | null;
    }>,
    reviews: [] as Array<{
      id: number;
      own: boolean;
      state: string;
      commitId: string;
      body: string;
      comments: Array<{ path: string; line: number; body: string }>;
    }>,
    comments: [] as Array<{ id: number; own: boolean; body: string }>,
    replies: [] as Array<{ id: number; commentId: number; body: string }>,
    /** Writes GitHub accepts whose answer never reaches the caller. */
    loseNextAnswer: new Set<string>(),
    writes: [] as string[],
  };
  const chat = {
    metadata: {} as Record<string, Json>,
    results: [] as Array<Record<string, Json>>,
    commit: input.head,
    /** The turn working now (ADR 0333), as inspect reports it. */
    turn: null as { id: string; status: string } | null,
    /** Where the chat runs; a chat waiting for a machine has no placement yet. */
    placement: { environment: "review" } as { environment: string } | null,
    /** Why a metadata write is refused (the cap an agent filled), if it is. */
    refuseMetadata: null as string | null,
  };
  const answered = (action: string, value: Json) => {
    if (github.loseNextAnswer.delete(action))
      throw new Error(
        `${action}: the connection dropped after GitHub accepted`,
      );
    return value;
  };
  const connections = {
    github: {
      get: ({ path }: { path: string }) => {
        const run = /\/check-runs\/(\d+)$/.exec(path);
        if (!run)
          return {
            status: 200,
            body: { state: github.state, head: { sha: github.head } },
          };
        const found = github.checks.find(
          (entry) => entry.id === Number(run[1]),
        );
        return found
          ? {
              status: 200,
              body: {
                id: found.id,
                status: found.status,
                conclusion: found.conclusion,
                output: { title: found.title },
              },
            }
          : { status: 404, body: { message: "Not Found" } };
      },
      // As the typed action lists them: the run's title is not among them.
      check_runs: ({ commit }: { commit: string }) => ({
        runs: github.checks
          .filter((run) => run.headSha === commit)
          .map(({ title: _title, ...run }) => run),
      }),
      create_check_run: (args: {
        headSha: string;
        status?: string;
        conclusion?: string;
        output?: { title: string };
        stamp: string;
      }) => {
        const existing = github.checks.find(
          (run) =>
            run.own &&
            run.externalId === args.stamp &&
            run.headSha === args.headSha,
        );
        if (existing) return { ...existing, existing: true };
        const run = {
          id: nextId++,
          own: true,
          status: args.status ?? "completed",
          conclusion: args.conclusion ?? null,
          externalId: args.stamp,
          headSha: args.headSha,
          title: args.output?.title ?? null,
        };
        github.checks.push(run);
        github.writes.push(`check:${args.conclusion ?? run.status}`);
        return answered("create_check_run", { id: run.id });
      },
      update_check_run: (args: {
        checkRunId: number;
        status?: string;
        conclusion?: string;
        output?: { title: string };
      }) => {
        const run = github.checks.find((entry) => entry.id === args.checkRunId);
        if (!run) throw new Error(`No check run ${args.checkRunId}`);
        if (args.status) run.status = args.status;
        if (args.conclusion) run.conclusion = args.conclusion;
        if (args.output) run.title = args.output.title;
        github.writes.push(
          `update:${run.headSha.slice(0, 1)}:${args.conclusion ?? args.output?.title}`,
        );
        return answered("update_check_run", { id: run.id });
      },
      pull_request_files: () => ({
        files: [{ path: "src/orders.ts", patch: "@@ -1,1 +1,2 @@\n a\n+b" }],
      }),
      list_reviews: () => ({ reviews: github.reviews }),
      create_review: (args: {
        event: string;
        commitId: string;
        body: string;
        comments?: Array<{ path: string; line: number; body: string }>;
        stamp: string;
      }) => {
        const existing = github.reviews.find(
          (review) => review.own && review.body.includes(args.stamp),
        );
        if (existing) return { id: existing.id, existing: true };
        const review = {
          id: nextId++,
          own: true,
          state:
            args.event === "REQUEST_CHANGES"
              ? "CHANGES_REQUESTED"
              : "COMMENTED",
          commitId: args.commitId,
          body: args.body,
          comments: args.comments ?? [],
        };
        github.reviews.push(review);
        github.writes.push(
          `review:${args.event}${review.comments.map((comment) => `:${comment.path}:${comment.line}`).join("")}`,
        );
        return answered("create_review", { id: review.id });
      },
      review_threads: () => ({
        threads: [{ id: "T1", comments: [{ id: 7, own: false }] }],
      }),
      reply_to_review_comment: (args: {
        commentId: number;
        body: string;
        stamp: string;
      }) => {
        const existing = github.replies.find((reply) =>
          reply.body.includes(args.stamp),
        );
        if (existing) return { id: existing.id, existing: true };
        const reply = {
          id: nextId++,
          commentId: args.commentId,
          body: args.body,
        };
        github.replies.push(reply);
        github.writes.push(`reply:${args.commentId}`);
        return answered("reply_to_review_comment", { id: reply.id });
      },
      issue_comment: (args: { body: string; stamp: string }) => {
        const existing = github.comments.find(
          (entry) => entry.own && entry.body.includes(args.stamp),
        );
        if (existing) return { id: existing.id, existing: true };
        const entry = { id: nextId++, own: true, body: args.body };
        github.comments.push(entry);
        github.writes.push("comment");
        return answered("issue_comment", { id: entry.id });
      },
    },
  };
  const sessions = {
    inspect: ({ sessionId }: { sessionId: string }) => ({
      id: sessionId,
      projectId: "project-1",
      owner: "project",
      agentId: "project:project-1:reviewer",
      environment: "review",
      placement: structuredClone(chat.placement),
      keyWorkflows: ["reviewPullRequests"],
      workspace: { ref: "refs/pull/42/head", commit: chat.commit },
      metadata: structuredClone(chat.metadata),
      turn: structuredClone(chat.turn),
    }),
    // As core reads them: newest first, at most 100, by name and turn.
    results: ({ name, turnId }: { name?: string; turnId?: string }) => ({
      results: structuredClone(
        chat.results
          .filter(
            (result) =>
              (name === undefined || result.name === name) &&
              (turnId === undefined || result.turnId === turnId),
          )
          .slice(0, 100),
      ),
    }),
    setMetadata: ({ set }: { set: Record<string, Json> }) => {
      if (chat.refuseMetadata) throw new Error(chat.refuseMetadata);
      for (const [key, value] of Object.entries(set)) {
        if (value === null) delete chat.metadata[key];
        else chat.metadata[key] = structuredClone(value);
      }
      return {
        sessionId: "session-1",
        metadata: structuredClone(chat.metadata),
      };
    },
  };
  const calls = <T extends Record<string, (args: never) => Json>>(target: T) =>
    Object.fromEntries(
      Object.entries(target).map(([name, fn]) => [
        name,
        (args: never, options?: { state?: Json }) => ({
          // A call's result is journaled as JSON: a retry sees what was answered.
          __call: async () => structuredClone(await fn(args)),
          ...(options && "state" in options ? { state: options.state } : {}),
        }),
      ]),
    );
  return {
    github,
    chat,
    context: {
      host: { "catamorphic.sessions": calls(sessions) },
      connections: { github: calls(connections.github) },
    },
    /** A request reached the chat after every result: none is current. */
    requestArrived() {
      for (const result of chat.results) result.current = false;
    },
    /** The reviewer's turn submits this review (ADR 0323). */
    submit(turnId: string, review: FakeReview | null) {
      if (!review) return;
      chat.results.unshift({
        id: `result-${turnId}-${chat.results.length}`,
        sessionId: "session-1",
        turnId,
        attemptId: review.attemptId ?? `${turnId}-attempt-1`,
        name: "review",
        current: true,
        commit:
          review.turnCommit === undefined ? chat.commit : review.turnCommit,
        value: {
          reviewedCommit: review.reviewedCommit,
          verdict: review.verdict,
          score: review.verdict === "REQUEST_CHANGES" ? 2 : 4,
          summary: `Review of ${turnId}`,
          checkSummary: `Check of ${turnId}`,
          findings: review.findings ?? [],
          reply: review.reply ?? null,
        },
      });
    },
    /**
     * The reviewer's turn submits a verified finding (ADR 0336), and Work
     * records `session.result-recorded`: this returns that event.
     */
    find(turnId: string, finding: FakeFinding) {
      const { attemptId, turnCommit, ...fields } = finding;
      const result = {
        id: `finding-${turnId}-${chat.results.length}`,
        sessionId: "session-1",
        turnId,
        attemptId: attemptId ?? `${turnId}-attempt-1`,
        name: "finding",
        current: true,
        commit: turnCommit === undefined ? chat.commit : turnCommit,
        value: {
          path: "src/orders.ts",
          line: 2,
          severity: "blocking",
          title: `Finding ${finding.id}`,
          body: `Why ${finding.id} is wrong.`,
          ...fields,
        },
      };
      chat.results.unshift(result);
      return resultEvent(result);
    },
  };
}

/** A turn's status change, as `session.turn-changed` carries it. */
export function turnEvent(turnId: string, status = "completed") {
  return {
    kind: "session.turn-changed",
    payload: {
      sessionId: "session-1",
      session: { id: "session-1", key: "pr-acme/web-42", status: "active" },
      detail: { turnId, messageId: `input-${turnId}`, status },
    },
  };
}

/** A recorded result, as `session.result-recorded` carries it. */
function resultEvent(result: Record<string, Json>) {
  return {
    kind: "session.result-recorded",
    payload: {
      sessionId: "session-1",
      session: { id: "session-1", key: "pr-acme/web-42", status: "active" },
      detail: {
        resultId: result.id,
        name: result.name,
        value: result.value,
        turnId: result.turnId,
        attemptId: result.attemptId,
        commit: result.commit,
      },
    },
  };
}

type Workflow = {
  concurrency?: { key: string; onConflict: string };
  steps: ReadonlyArray<{
    run: (context: Record<string, unknown>) => unknown;
    retry?: { maxAttempts: number };
  }>;
};

/**
 * A value as Work keeps it between boundaries: jsonb, whose objects order
 * their keys by length, then bytewise. Arrays keep their order.
 */
function asJsonb(value: Json): Json {
  if (Array.isArray(value)) return value.map(asJsonb);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) =>
        left.length !== right.length
          ? left.length - right.length
          : left < right
            ? -1
            : left > right
              ? 1
              : 0,
      )
      .map(([key, item]) => [key, asJsonb(item as Json)]),
  );
}

/** One run: each boundary's call, retried from its own input when it throws. */
export async function runWorkflow(
  workflow: Workflow,
  input: Json,
  context: Record<string, unknown>,
): Promise<Json> {
  let current = input;
  for (const step of workflow.steps) {
    const attempts = step.retry?.maxAttempts ?? 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const returned = (await step.run({ ...context, input: current })) as
          | Call
          | Json;
        if (returned && typeof returned === "object" && "__call" in returned) {
          const call = returned as Call;
          const result = await call.__call();
          current = asJsonb(
            "state" in call ? { result, state: call.state } : result,
          );
        } else current = asJsonb(returned);
        break;
      } catch (error) {
        if (attempt >= attempts) throw error;
      }
    }
  }
  return current;
}

/**
 * Overlapping runs, as triggers start them: runs whose declared key names
 * the same subject take turns in arrival order; others run alongside.
 */
export async function runOverlapping(
  workflow: Workflow,
  inputs: Json[],
  context: Record<string, unknown>,
): Promise<Json[]> {
  const lanes = new Map<string, Promise<unknown>>();
  return Promise.all(
    inputs.map((input) => {
      const path = workflow.concurrency?.key;
      const key = path
        ? path
            .split(".")
            .reduce<unknown>(
              (value, segment) =>
                value && typeof value === "object"
                  ? (value as Record<string, unknown>)[segment]
                  : undefined,
              input,
            )
        : undefined;
      if (
        typeof key !== "string" ||
        workflow.concurrency?.onConflict !== "queue"
      )
        return runWorkflow(workflow, input, context);
      const run = (lanes.get(key) ?? Promise.resolve()).then(() =>
        runWorkflow(workflow, input, context),
      );
      lanes.set(
        key,
        run.catch(() => {}),
      );
      return run;
    }),
  );
}
