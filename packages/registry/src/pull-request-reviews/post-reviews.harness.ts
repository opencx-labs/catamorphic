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
  comments?: Array<{ path: string; line: number; side?: string; body: string }>;
  /** The attempt that submitted it; the turn may have later attempts. */
  attemptId?: string;
  /** The commit Work recorded the turn began on; the chat's commit when absent. */
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
      conclusion: string;
      externalId: string | null;
      headSha: string;
    }>,
    reviews: [] as Array<{
      id: number;
      own: boolean;
      state: string;
      commitId: string;
      body: string;
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
      get: () => ({
        status: 200,
        body: { state: github.state, head: { sha: github.head } },
      }),
      check_runs: ({ commit }: { commit: string }) => ({
        runs: github.checks.filter((run) => run.headSha === commit),
      }),
      create_check_run: (args: {
        headSha: string;
        conclusion: string;
        stamp: string;
      }) => {
        const existing = github.checks.find(
          (run) => run.own && run.externalId === args.stamp,
        );
        if (existing) return { ...existing, existing: true };
        const run = {
          id: nextId++,
          own: true,
          conclusion: args.conclusion,
          externalId: args.stamp,
          headSha: args.headSha,
        };
        github.checks.push(run);
        github.writes.push(`check:${args.conclusion}`);
        return answered("create_check_run", { id: run.id });
      },
      pull_request_files: () => ({
        files: [{ path: "src/orders.ts", patch: "@@ -1,1 +1,2 @@\n a\n+b" }],
      }),
      list_reviews: () => ({ reviews: github.reviews }),
      create_review: (args: {
        event: string;
        commitId: string;
        body: string;
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
        };
        github.reviews.push(review);
        github.writes.push(`review:${args.event}`);
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
      placement: { environment: "review" },
      keyWorkflows: ["reviewPullRequests"],
      workspace: { ref: "refs/pull/42/head", commit: chat.commit },
      metadata: structuredClone(chat.metadata),
    }),
    results: () => ({ results: structuredClone(chat.results) }),
    setMetadata: ({ set }: { set: Record<string, Json> }) => {
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
          comments: review.comments ?? [],
          reply: review.reply ?? null,
        },
      });
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
          current = "state" in call ? { result, state: call.state } : result;
        } else current = returned;
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
