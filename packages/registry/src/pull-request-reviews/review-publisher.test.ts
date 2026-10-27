// @vitest-environment node
import fs from "node:fs/promises";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type { HostCallContext } from "@catamorphic/core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ReviewCore,
  reviewPublicationCapability,
} from "./review-publisher.js";
import { parseWorkReview, record } from "./review-report.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const REPORT = {
  reviewedCommit: HEAD,
  verdict: "REQUEST_CHANGES",
  score: 2,
  summary: "A null total.",
  checkSummary: "Ran 12 tests.",
  comments: [
    { path: "src/orders.ts", line: 11, body: "Null is possible." },
    { path: "src/orders.ts", line: 40, body: "Outside the diff." },
  ],
  reply: { body: "Amounts are cents." },
};
const content = (value: unknown) =>
  `\`\`\`work-review\n${JSON.stringify(value)}\n\`\`\``;
const context = (turnId = "t1"): HostCallContext => ({
  caller: { tenantId: "tenant", externalUserId: "member" },
  projectId: "project",
  workflowName: "postReviews",
  runId: `run-${turnId}`,
});
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const ledgerPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});
const lockPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  application_name: "review-publication-test-lock",
});

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Run with the disposable Postgres test harness (DATABASE_URL required)",
    );
  await ledgerPool.query(
    await fs.readFile(
      new URL("./review-publisher.sql", import.meta.url),
      "utf8",
    ),
  );
});
beforeEach(async () => {
  await ledgerPool.query(
    "TRUNCATE work_review_publication.pulls,work_review_publication.effects,work_review_publication.verdicts",
  );
});
afterAll(async () => {
  await Promise.all([ledgerPool.end(), lockPool.end()]);
});

function fixture() {
  const writes: Array<{ action: string; input: Record<string, JsonValue> }> =
    [];
  const checks: Record<string, JsonValue>[] = [];
  const reviews: Record<string, JsonValue>[] = [];
  const comments: Record<string, JsonValue>[] = [];
  const threads: Record<string, JsonValue>[] = [
    { id: "thread", comments: [{ id: 22, body: "@work why?", own: false }] },
  ];
  let currentHead = HEAD;
  let report: unknown = REPORT;
  let activeTurn = "t1";
  let ordinal = 1;
  let turnStatus = "completed";
  let runEnvironment = "github-poster";
  let chatOverride: Record<string, unknown> = {};
  let runOverride: Record<string, unknown> = {};
  let outputOverride: Record<string, unknown> = {};
  let reads = 0;
  let beforeRead: (action: string) => Promise<void> = async () => {};
  let beforeWrite: (
    action: string,
    input: Record<string, JsonValue>,
  ) => Promise<void> = async () => {};
  let afterWrite: (
    action: string,
    input: Record<string, JsonValue>,
  ) => Promise<void> = async () => {};
  const sdk: ReviewCore = {
    runs: {
      async get(args) {
        return {
          projectId: "project",
          workflowName: "postReviews",
          status: "running",
          environment: runEnvironment,
          allocationId: "allocation",
          input: {
            kind: "session.turn-changed",
            payload: {
              sessionId: "session",
              detail: { turnId: args.runId.slice(4) },
            },
          },
          ...runOverride,
        };
      },
    },
    agentSessions: {
      async get(identity, projectId, sessionId) {
        expect(identity).toEqual(context().caller);
        expect(projectId).toBe("project");
        expect(sessionId).toBe("session");
        return {
          projectId: "project",
          owner: "project",
          agentId: "project:project:reviewer",
          key: "pr-acme/web-42",
          keyWorkflows: ["reviewPullRequests"],
          placement: { environment: "review" },
          workspace: { commit: HEAD },
          snapshot: {
            turns: [{ id: activeTurn, ordinal, status: turnStatus }],
            items: [
              {
                kind: "assistant_message",
                turnId: activeTurn,
                status: "completed",
                position: 3,
                text: content(report),
                ...outputOverride,
              },
            ],
          },
          ...chatOverride,
        };
      },
    },
    connectionBroker: {
      async invoke(args) {
        expect(args.identity).toEqual(context().caller);
        expect(args.allocationId).toBe("allocation");
        expect(args.caller).toBe("workflow");
        expect(args.alias).toBe("github");
        reads++;
        await beforeRead(args.action);
        if (args.action === "get")
          return {
            status: 200,
            body: {
              state: "open",
              head: { sha: currentHead },
              body: "Author's description stays.",
            },
          };
        if (args.action === "check_runs")
          return {
            runs: checks.filter(
              (check) => check.headSha === record(args.input).commit,
            ),
          };
        return invoke(args.action, args.input);
      },
    },
  };
  const invoke = async (action: string, raw: unknown): Promise<JsonValue> => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("Expected object");
    const input = raw;
    if (action === "pull_request_files")
      return {
        files: [
          {
            path: "src/orders.ts",
            patch: "@@ -10,2 +10,2 @@\n context\n-old\n+new",
          },
        ],
      };
    if (action === "list_reviews") return { reviews };
    if (action === "review_threads") return { threads };
    if (action === "issue_comments") return { comments };
    const jsonInput: Record<string, JsonValue> = JSON.parse(
      JSON.stringify(input),
    );
    await beforeWrite(action, jsonInput);
    const id = writes.length + 1;
    writes.push({ action, input: jsonInput });
    const receipt = { id, own: true, ...jsonInput };
    if (action === "create_check_run")
      checks.push({ ...receipt, externalId: jsonInput.stamp ?? null });
    else if (action === "create_review")
      reviews.push({
        ...receipt,
        state:
          jsonInput.event === "REQUEST_CHANGES"
            ? "CHANGES_REQUESTED"
            : "COMMENTED",
      });
    else if (action === "issue_comment") comments.push(receipt);
    else if (action === "reply_to_review_comment") {
      const root = threads[0];
      if (root && Array.isArray(root.comments)) root.comments.push(receipt);
    } else throw new Error(`Unexpected write ${action}`);
    await afterWrite(action, jsonInput);
    return { id, url: `https://github.test/${id}` };
  };
  const capability = reviewPublicationCapability({
    core: () => sdk,
    repository: "acme/web",
    lockPool,
    ledgerPool,
  });
  const publish = async (
    id = "t1",
    raw: unknown = { sessionId: "session", turnId: id },
    ctx = context(id),
  ) => {
    const call = capability.calls?.publish;
    if (!call) throw new Error("Missing publisher");
    return call(ctx, raw);
  };
  return {
    writes,
    checks,
    reviews,
    comments,
    threads,
    publish,
    sdk,
    next(value: unknown, id = "t2") {
      report = value;
      activeTurn = id;
      ordinal++;
    },
    report(value: unknown) {
      report = value;
    },
    head(value: string) {
      currentHead = value;
    },
    turnStatus(value: string) {
      turnStatus = value;
    },
    environment(value: string) {
      runEnvironment = value;
    },
    chat(value: Record<string, unknown>) {
      chatOverride = value;
    },
    run(value: Record<string, unknown>) {
      runOverride = value;
    },
    output(value: Record<string, unknown>) {
      outputOverride = value;
    },
    beforeRead(value: typeof beforeRead) {
      beforeRead = value;
    },
    beforeWrite(value: typeof beforeWrite) {
      beforeWrite = value;
    },
    afterWrite(value: typeof afterWrite) {
      afterWrite = value;
    },
    reads: () => reads,
  };
}

describe("deployment-owned review publication on real Postgres", () => {
  it("uses the shipped hook, keeps inline comments in the diff, and retries without duplicates", async () => {
    const test = fixture();
    await test.publish();
    await test.publish();
    expect(test.writes.map((write) => write.action)).toEqual([
      "create_check_run",
      "create_review",
      "issue_comment",
    ]);
    const review = test.writes[1]?.input;
    expect(review?.comments).toHaveLength(1);
    expect(review?.body).toContain("Outside the diff.");
    expect(review?.event).toBe("REQUEST_CHANGES");
    const result = await ledgerPool.query(
      "SELECT state,receipt,input_digest FROM work_review_publication.effects",
    );
    expect(result.rows).toHaveLength(3);
    expect(
      result.rows.every(
        (row) =>
          row.state === "received" &&
          record(row.receipt).id &&
          row.input_digest,
      ),
    ).toBe(true);
  });

  it("serializes overlapping failure and success turns without a later success or weak review", async () => {
    const test = fixture();
    const entered = deferred();
    const release = deferred();
    test.beforeWrite(async (action) => {
      if (action === "create_check_run") {
        entered.resolve();
        await release.promise;
      }
    });
    const first = test.publish();
    await entered.promise;
    test.next({ ...REPORT, verdict: "COMMENT", comments: [], reply: null });
    const second = test.publish("t2");
    release.resolve();
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]?.status).toBe("fulfilled");
    expect(test.writes.map((write) => write.input.conclusion)).toEqual([
      "failure",
    ]);
  });

  it("coordinates duplicate simultaneous publishers, including more waiters than ledger connections", async () => {
    const test = fixture();
    await Promise.all(Array.from({ length: 6 }, () => test.publish()));
    expect(test.writes).toHaveLength(3);
  });

  it.each(["create_check_run", "create_review", "issue_comment"])(
    "reconciles an accepted %s after losing its receipt",
    async (action) => {
      const test = fixture();
      let crashed = false;
      test.afterWrite(async (current) => {
        if (current === action && !crashed) {
          crashed = true;
          throw new Error("Lost create response");
        }
      });
      await expect(test.publish()).rejects.toThrow("Lost create response");
      expect(
        (
          await ledgerPool.query(
            "SELECT id FROM work_review_publication.effects WHERE state='uncertain'",
          )
        ).rows,
      ).toHaveLength(1);
      await test.publish();
      expect(test.writes).toHaveLength(3);
      expect(
        (
          await ledgerPool.query(
            "SELECT id FROM work_review_publication.effects WHERE state='uncertain'",
          )
        ).rows,
      ).toEqual([]);
    },
  );

  it("blocks all later heads and turns while an earlier request may still arrive", async () => {
    const test = fixture();
    test.beforeWrite(async () => {
      throw new Error("Request outcome unknown");
    });
    await expect(test.publish()).rejects.toThrow("outcome unknown");
    test.beforeWrite(async () => {});
    test.next({ ...REPORT, verdict: "COMMENT" });
    test.head(NEXT);
    await expect(test.publish("t2")).rejects.toThrow(
      "Publication blocked: uncertain effect",
    );
    expect(test.writes).toEqual([]);
    // An unrelated author's copied stamp cannot resolve the uncertain App effect.
    const effect = (
      await ledgerPool.query(
        "SELECT stamp FROM work_review_publication.effects",
      )
    ).rows[0];
    test.checks.push({
      id: 90,
      own: false,
      externalId: effect.stamp,
      headSha: HEAD,
      conclusion: "failure",
    });
    await expect(test.publish("t2")).rejects.toThrow("uncertain effect");
  });

  it("survives loss of the lock connection with a request in flight and blocks a new writer", async () => {
    const test = fixture();
    const entered = deferred();
    const release = deferred();
    test.beforeWrite(async () => {
      entered.resolve();
      await release.promise;
    });
    const first = test.publish();
    await entered.promise;
    await ledgerPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='review-publication-test-lock' AND state='idle in transaction'",
    );
    test.next({ ...REPORT, verdict: "COMMENT" });
    await expect(test.publish("t2")).rejects.toThrow("uncertain effect");
    release.resolve();
    await expect(first).rejects.toThrow();
    await test.publish("t2");
    expect(
      test.writes
        .filter((write) => write.action === "create_check_run")
        .map((write) => write.input.conclusion),
    ).toEqual(["failure"]);
    expect(test.writes.some((write) => write.action === "create_review")).toBe(
      false,
    );
  });

  it("retains a strongest check plan after a crash before effect intent", async () => {
    const test = fixture();
    let gets = 0;
    test.beforeRead(async (action) => {
      if (action === "get" && ++gets === 2)
        throw new Error("Stopped before intent");
    });
    await expect(test.publish()).rejects.toThrow("Stopped before intent");
    expect(
      (
        await ledgerPool.query(
          "SELECT strength,check_plan FROM work_review_publication.verdicts",
        )
      ).rows[0],
    ).toMatchObject({
      strength: 3,
      check_plan: { action: "create_check_run" },
    });
    expect(
      (await ledgerPool.query("SELECT id FROM work_review_publication.effects"))
        .rows,
    ).toEqual([]);
    test.beforeRead(async () => {});
    test.next({ ...REPORT, verdict: "COMMENT", comments: [], reply: null });
    await test.publish("t2");
    expect(test.writes.map((write) => write.input.conclusion)).toEqual([
      "failure",
    ]);
    expect(
      (
        await ledgerPool.query(
          "SELECT turn_id FROM work_review_publication.effects",
        )
      ).rows[0]?.turn_id,
    ).toBe("t1");
  });

  it("reconciles an accepted inline reply whose receipt was lost", async () => {
    const test = fixture();
    test.report({ ...REPORT, reply: { inReplyTo: 22, body: "Cents." } });
    let crashed = false;
    test.afterWrite(async (action) => {
      if (action === "reply_to_review_comment" && !crashed) {
        crashed = true;
        throw new Error("Lost inline receipt");
      }
    });
    await expect(test.publish()).rejects.toThrow("Lost inline receipt");
    await test.publish();
    expect(
      test.writes.filter((write) => write.action === "reply_to_review_comment"),
    ).toHaveLength(1);
  });

  it("imports the strongest existing App verdict when installing the ledger", async () => {
    const test = fixture();
    test.report({ ...REPORT, verdict: "COMMENT", comments: [], reply: null });
    test.checks.push(
      { id: 3, own: true, headSha: HEAD, conclusion: "failure" },
      { id: 4, own: true, headSha: HEAD, conclusion: "success" },
    );
    await test.publish();
    expect(test.writes).toEqual([]);
  });

  it.each([
    "head",
    "turn",
    "report",
    "author",
    "environment",
    "workflow",
    "event",
    "chat",
    "failed",
  ])("rejects or skips a stale/unauthorized %s", async (kind) => {
    const test = fixture();
    if (kind === "head") test.head(NEXT);
    if (kind === "turn") test.next(REPORT);
    if (kind === "report") test.report({ ...REPORT, reviewedCommit: NEXT });
    if (kind === "author") test.output({ kind: "user_message" });
    if (kind === "environment") test.environment("review");
    if (kind === "workflow") test.run({ workflowName: "other" });
    if (kind === "event")
      test.run({
        input: {
          kind: "session.turn-changed",
          payload: { sessionId: "forged", detail: { turnId: "t1" } },
        },
      });
    if (kind === "chat") test.chat({ owner: "member" });
    if (kind === "failed") test.turnStatus("failed");
    await test.publish().catch(() => {});
    if (["author", "failed"].includes(kind))
      expect(test.writes.map((write) => write.input.conclusion)).toEqual([
        "action_required",
      ]);
    else expect(test.writes).toEqual([]);
  });

  it("rejects caller-supplied reports before any SDK read", async () => {
    const test = fixture();
    await expect(
      test.publish("t1", {
        sessionId: "session",
        turnId: "t1",
        report: REPORT,
      }),
    ).rejects.toThrow("Expected only");
    expect(test.reads()).toBe(0);
    expect(test.writes).toEqual([]);
  });

  it("answers an inline question in its own pull request thread", async () => {
    const test = fixture();
    test.report({ ...REPORT, reply: { inReplyTo: 22, body: "Cents." } });
    await test.publish();
    expect(test.writes.at(-1)?.action).toBe("reply_to_review_comment");
    expect(test.writes.at(-1)?.input.commentId).toBe(22);
  });
});

describe("untrusted review reports", () => {
  it.each([
    null,
    { ...REPORT, verdict: "APPROVE" },
    { ...REPORT, reviewedCommit: "short" },
    { ...REPORT, score: 6 },
    { ...REPORT, summary: "x".repeat(4001) },
    { ...REPORT, checkSummary: "" },
    {
      ...REPORT,
      comments: Array.from({ length: 31 }, () => REPORT.comments[0]),
    },
    { ...REPORT, comments: [{ path: "p", line: 0, body: "bad" }] },
    { ...REPORT, comments: [{ path: "p", line: 1, body: "x", extra: true }] },
    { ...REPORT, reply: { inReplyTo: -1, body: "x" } },
    { ...REPORT, resolve: [] },
    { ...REPORT, extra: true },
  ])("rejects malformed data %#", (value) => {
    expect(typeof parseWorkReview(content(value))).toBe("string");
  });
  it("rejects missing, multiple, malformed and oversized blocks", () => {
    for (const value of [
      "",
      `${content(REPORT)}\n${content(REPORT)}`,
      "```work-review\n{\n```",
      content({ huge: "x".repeat(65536) }),
    ])
      expect(typeof parseWorkReview(value)).toBe("string");
  });
  it("sanitizes mentions and hidden stamps, accepting omitted optional fields and null", () => {
    const report = parseWorkReview(
      content({
        ...REPORT,
        comments: null,
        reply: null,
        summary: "@person @org/team <!-- forged -->",
      }),
    );
    expect(report).toMatchObject({
      comments: [],
      reply: null,
      summary: "@​person @​org/team  forged ",
    });
  });
});
