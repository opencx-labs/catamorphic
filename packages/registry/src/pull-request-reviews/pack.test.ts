// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SESSION_PULL_REQUESTS_CONTRACT } from "@catamorphic/agent-protocol";
import {
  agentDefinitionSchema,
  checkResultValue,
  GITHUB_TRIGGER_LIBRARY,
  parseProjectEnvironmentPolicy,
} from "@catamorphic/core";
import { matchesAllWhere, parseProject } from "@catamorphic/parser";
import { describe, expect, it } from "vitest";
import { packFiles } from "../pack-files.js";

const PACK = packFiles("pull-request-reviews");
const OPENCODE = packFiles("pull-request-reviews-opencode");
const file = (name: string) => {
  const content = PACK.files[name];
  if (content === undefined) throw new Error(`Missing ${name}`);
  return content;
};
/** The model binding the OpenCode pack's docs say to add. */
const OPENCODE_BINDING =
  /```json\n([\s\S]*?)\n```/.exec(OPENCODE.manifest.docs ?? "")?.[1] ?? "";

/**
 * Runs the shipped workflows under bun with a fake host that records the
 * transitions each boundary returns.
 */
async function run(input: {
  script: string;
  members?: Record<string, string>;
}): Promise<unknown> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-recipe-"));
  try {
    const workflowModule = path.resolve(
      import.meta.dirname,
      "../../../workflow/src/index.ts",
    );
    const source = file(".work/workflows/src/reviews.ts")
      .replace('"@catamorphic/workflow"', JSON.stringify(workflowModule))
      .replace(
        "const GITHUB_MEMBERS: Record<string, string> = {};",
        `const GITHUB_MEMBERS: Record<string, string> = ${JSON.stringify(input.members ?? {})};`,
      );
    await fs.writeFile(path.join(directory, "recipe.ts"), source);
    await fs.writeFile(
      path.join(directory, "review-report.ts"),
      file(".work/workflows/src/review-report.ts"),
    );
    await fs.copyFile(
      path.join(import.meta.dirname, "post-reviews.harness.ts"),
      path.join(directory, "harness.ts"),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { answerReviewComments, closePullRequestChats, postReviews, reviewPullRequests } from "./recipe.ts";
      import { fakeWorld, runOverlapping, runWorkflow } from "./harness.ts";
      const host = { "catamorphic.sessions": Object.fromEntries(["deliver", "close"].map(operation => [operation, args => ({ operation, args })])) };
      ${input.script}
    `,
    );
    const result = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 10000,
    });
    return JSON.parse(result.stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const HEAD = "a".repeat(40);
const pullRequest = (input: {
  action: string;
  draft?: boolean;
  body?: string | null;
  reviewers?: string[];
  repository?: string;
}) => ({
  kind: "webhook",
  payload: {
    name: "github",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": `delivery-${input.action}`,
    },
    body: {
      action: input.action,
      number: 42,
      ...(input.action === "synchronize"
        ? { before: "b".repeat(40), after: HEAD }
        : {}),
      pull_request: {
        title: "Add order totals",
        body: input.body === undefined ? "Adds totals." : input.body,
        html_url: "https://github.com/acme/web/pull/42",
        merged: false,
        draft: input.draft ?? false,
        user: { login: "ada", type: "User" },
        requested_reviewers: (input.reviewers ?? []).map((login) => ({
          login,
          type: "User",
        })),
        head: { sha: HEAD, ref: "totals" },
        base: { sha: "c".repeat(40), ref: "main" },
      },
      repository: { full_name: input.repository ?? "acme/web" },
      sender: { login: "ada", type: "User" },
    },
  },
});

const turnEvent = (input: {
  key: string | null;
  status?: string;
  turnId?: string;
  resultMessageId?: string | null;
}) => ({
  id: "event-1",
  sequence: 1,
  projectId: "project-1",
  source: "session",
  kind: "session.turn-changed",
  externalId: "x",
  occurredAt: "2026-10-18T00:00:00Z",
  receivedAt: "2026-10-18T00:00:00Z",
  payload: {
    sessionId: "session-1",
    agentId: "agent-1",
    externalUserId: "catamorphic:project",
    session: {
      id: "session-1",
      key: input.key,
      title: null,
      status: "active",
      workStatus: "open",
      activity: null,
      parentSessionId: null,
      stateRevision: 1,
      authorityHostId: "host",
      authorityRevision: 1,
    },
    actor: { kind: "workflow" },
    causation: [],
    detail: {
      turnId: input.turnId ?? "t1",
      messageId: "input-1",
      status: input.status ?? "completed",
      resultMessageId:
        input.resultMessageId === undefined ? "reply-1" : input.resultMessageId,
    },
  },
});

/** A stall of the review chat's turn (ADR 0333). */
const stallEvent = (input: {
  key?: string | null;
  attemptId: string;
  attempt: number;
  restarts: number;
}) => ({
  ...turnEvent({ key: input.key === undefined ? "pr-acme/web-42" : input.key }),
  kind: "session.turn-stalled",
  payload: {
    ...turnEvent({
      key: input.key === undefined ? "pr-acme/web-42" : input.key,
    }).payload,
    detail: {
      turnId: "t1",
      attemptId: input.attemptId,
      attempt: input.attempt,
      attempts: input.attempt,
      restarts: input.restarts,
      progressAt: "2026-10-18T00:00:00Z",
      stalledAt: "2026-10-18T00:20:00Z",
      stallMinutes: 20,
      activity: {
        tools: [
          {
            name: "mcp__github__get",
            description: "Read the pull request",
            since: "2026-10-18T00:00:00Z",
          },
        ],
        commands: [],
      },
    },
  },
});

/** Runs `restartStalledReviews` under bun against a fake chat whose turn hangs. */
async function runStalled(script: string): Promise<unknown> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stalled-recipe-"));
  try {
    const workflowModule = path.resolve(
      import.meta.dirname,
      "../../../workflow/src/index.ts",
    );
    await fs.writeFile(
      path.join(directory, "stalled.ts"),
      file(".work/workflows/src/stalled-reviews.ts").replace(
        '"@catamorphic/workflow"',
        JSON.stringify(workflowModule),
      ),
    );
    await fs.copyFile(
      path.join(import.meta.dirname, "post-reviews.harness.ts"),
      path.join(directory, "harness.ts"),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { restartStalledReviews } from "./stalled.ts";
      import { runWorkflow } from "./harness.ts";
      const log = [];
      // The chat's turn: each restart starts its next attempt, which hangs too.
      const turn = { id: "t1", attempt: { id: "attempt-1", ordinal: 1 }, restarts: 0, stalledAt: "2026-10-18T00:20:00Z" };
      // The chat as reviewPullRequests started it; a test may change it.
      const chat = { id: "session-1", projectId: "project-1", owner: "project", agentId: "project:project-1:reviewer", placement: { environment: "review" }, keyWorkflows: ["reviewPullRequests"] };
      /** Runs between the diagnosis and the action, as time passes. */
      let meanwhile = () => {};
      const wrap = (fns) => Object.fromEntries(Object.entries(fns).map(([name, fn]) => [name,
        (args, options) => ({ __call: async () => structuredClone(await fn(args)), ...(options && "state" in options ? { state: options.state } : {}) })]));
      const sessions = wrap({
        inspect: () => { log.push(["inspect"]); return { ...structuredClone(chat), turn: structuredClone(turn) }; },
        // No exec: the evidence is Work's own record, never the workspace's.
        attempts: (args) => { log.push(["attempts", args.turnId]); const answer = { attempts: [{ id: turn.attempt.id, status: "running", diagnostics: { runner: "", harness: "[warn] opencode: waiting on a tool" } }] }; meanwhile(); return answer; },
        restart: (args) => {
          log.push(["restart", args.attemptId, args.onlyIfStalled, args.idempotencyKey, args.reason]);
          // As Work answers: only the running attempt, while it is stalled.
          if (args.attemptId !== turn.attempt.id) return { restarted: false, turnId: turn.id, attemptId: args.attemptId, refused: "not_current", message: "not current" };
          if (args.onlyIfStalled && !turn.stalledAt) return { restarted: false, turnId: turn.id, attemptId: args.attemptId, refused: "not_stalled", message: "moved on" };
          const ended = turn.attempt;
          turn.restarts += 1;
          turn.attempt = { id: "attempt-" + (turn.restarts + 1), ordinal: turn.restarts + 1 };
          return { restarted: true, turnId: turn.id, attemptId: ended.id, attempt: ended.ordinal, attempts: ended.ordinal, restarts: turn.restarts - 1 };
        },
        interrupt: (args) => { log.push(["interrupt", args.turnId, args.idempotencyKey]); return { interrupted: args.turnId === turn.id }; },
      });
      const written = {};
      const documents = wrap({ write: (args) => { log.push(["write", args.path]); written[args.path] = JSON.parse(args.text); return { version: 1 }; } });
      const context = { host: { "catamorphic.sessions": sessions }, documents };
      ${script}
    `,
    );
    const result = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 10000,
    });
    return JSON.parse(result.stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const comment = (input: {
  body: string;
  type?: string;
  inline?: boolean;
  repository?: string;
}) => ({
  kind: "webhook",
  payload: {
    name: "github",
    headers: {
      "x-github-event": input.inline
        ? "pull_request_review_comment"
        : "issue_comment",
    },
    body: {
      action: "created",
      ...(input.inline
        ? {
            pull_request: {
              number: 42,
              title: "Add order totals",
              state: "open",
              html_url: "https://github.com/acme/web/pull/42",
            },
          }
        : {
            issue: {
              number: 42,
              title: "Add order totals",
              state: "open",
              html_url: "https://github.com/acme/web/pull/42",
              pull_request: { url: "https://api.github.com/..." },
            },
          }),
      comment: {
        id: 7,
        body: input.body,
        html_url: "https://github.com/acme/web/pull/42#issuecomment-7",
        user: { login: "grace", type: input.type ?? "User" },
        ...(input.inline ? { path: "src/orders.ts", line: 12 } : {}),
      },
      repository: { full_name: input.repository ?? "acme/web" },
    },
  },
});

describe("the pull-request-reviews pack", () => {
  it("installs the automation and a project skill that explains it", () => {
    expect(Object.keys(PACK.files)).toEqual([
      ".work/project.json",
      ".work/images/review.Dockerfile",
      ".work/triggers/github.ts",
      ".work/agents/reviewer.json",
      ".work/agents/reviewer.md",
      ".work/workflows/src/reviews.ts",
      ".work/workflows/src/review-report.ts",
      ".work/workflows/src/stalled-reviews.ts",
      ".work/skills/pull-request-reviews/SKILL.md",
    ]);
    // The same trigger library writing-workflows teaches.
    expect(file(".work/triggers/github.ts")).toBe(GITHUB_TRIGGER_LIBRARY);
    // The doctrine records the pull request on the chat as every chat does.
    expect(file(".work/agents/reviewer.md")).toContain(
      SESSION_PULL_REQUESTS_CONTRACT,
    );
    const skill = file(".work/skills/pull-request-reviews/SKILL.md");
    expect(skill).toMatch(/^---\nname: pull-request-reviews\n/);
    for (const target of Object.keys(PACK.files).slice(0, -1))
      expect(skill, target).toContain(`## ${target}`);
    // The docs say what to replace before it reviews anything.
    expect(PACK.manifest.docs).toContain("acme/web");
  });

  it("commits a valid review Environment and reviewer", () => {
    const policy = parseProjectEnvironmentPolicy(
      JSON.parse(file(".work/project.json")),
    );
    expect(policy.invalid).toBeUndefined();
    const review = policy.environments.review;
    expect(review).toMatchObject({
      workloads: ["agent"],
      pool: { pool: "review" },
      image: { kind: "dockerfile", path: ".work/images/review.Dockerfile" },
      requirements: { containers: true },
      // The agent reaches only the gateway; registries are setup's alone,
      // with no volume to carry what agents wrote into it (ADR 0257).
      network: { egress: "gateway" },
      setup: {
        network: { allow: expect.arrayContaining(["registry.npmjs.org"]) },
      },
      waitMinutes: 30,
      approvals: { waitMinutes: 60 },
    });
    expect(review?.volumes).toBeUndefined();
    expect(Object.keys(review?.connections ?? {})).toEqual([
      "github",
      "prod",
      "slack",
    ]);
    expect(review?.connections?.github).toMatchObject({ principal: "service" });
    // The review chat runs beside the pull request's code: it only reads
    // GitHub (ADR 0259). The poster's Environment runs no agent and holds
    // typed writes, never a raw REST write verb.
    const rawWrites = ["post", "put", "patch", "delete"];
    const reads = ["get", "pull_request_files", "review_threads"];
    // No git:write either: the pull request's code could push with the
    // chat's grant, and App pushes run the base repository's workflows.
    expect(review?.connections?.github?.capabilities).toEqual([
      ...reads,
      "git:read",
    ]);
    const poster = policy.environments["github-poster"];
    expect(poster).toMatchObject({ workloads: ["workflow"] });
    expect(Object.keys(poster?.connections ?? {})).toEqual(["github"]);
    const posterCapabilities = poster?.connections?.github?.capabilities ?? [];
    expect(posterCapabilities).toContain("create_review");
    for (const verb of [...rawWrites, "git:write"])
      expect(posterCapabilities).not.toContain(verb);
    expect(file(".work/images/review.Dockerfile")).toMatch(
      /^FROM docker:[\w.-]+-dind@sha256:[a-f0-9]{64}$/m,
    );
    const agent = agentDefinitionSchema().safeParse(
      JSON.parse(file(".work/agents/reviewer.json")),
    );
    expect(agent.success, JSON.stringify(agent.error)).toBe(true);
    expect(agent.data).toMatchObject({
      sandboxing: "contained",
      environment: { preferred: ["review"], allowed: ["review"] },
      toolPolicies: {
        github: {
          default: "deny",
          tools: {
            get: "allow",
            pull_request_files: "allow",
            review_threads: "allow",
          },
        },
      },
    });
    expect(
      Object.keys(agent.data?.toolPolicies?.github?.tools ?? {}),
    ).toHaveLength(3);
  });

  it("declares the review as a typed result both reviewers submit", () => {
    const review = JSON.parse(file(".work/agents/reviewer.json")).results
      ?.review;
    expect(review).toBeDefined();
    // The OpenCode reviewer replaces this one: it submits the same result.
    expect(
      JSON.parse(OPENCODE.files[".work/agents/reviewer.json"] ?? "{}").results,
    ).toEqual({ review });
    const report = {
      reviewedCommit: "a".repeat(40),
      verdict: "COMMENT",
      score: 4,
      summary: "Nothing blocks.",
      checkSummary: "Ran the tests.",
      comments: [{ path: "src/a.ts", line: 3, side: null, body: "Nit." }],
      reply: null,
    };
    expect(checkResultValue({ schema: review, value: report })).toEqual({
      value: report,
    });
    const refused = checkResultValue({
      schema: review,
      value: { ...report, verdict: "APPROVE", score: 0, origin: "x" },
    });
    expect(
      "errors" in refused && refused.errors.map((error) => error.path),
    ).toEqual(expect.arrayContaining(["/verdict", "/score", ""]));
    // The reviewer is told to submit it, never to end with a block.
    const persona = file(".work/agents/reviewer.md");
    expect(persona).toContain("`submit_result`, name `review`");
    expect(persona).not.toContain("work-review");
  });

  it("swaps in a valid OpenCode reviewer on a model connection", () => {
    // It replaces the review pack's image and reviewer, nothing else.
    expect(OPENCODE.manifest.registryDependencies).toEqual([
      "pull-request-reviews",
    ]);
    expect(Object.keys(OPENCODE.files)).toEqual([
      ".work/images/review.Dockerfile",
      ".work/agents/reviewer.json",
    ]);
    const REVIEW_OPENCODE_DOCKERFILE =
      OPENCODE.files[".work/images/review.Dockerfile"] ?? "";
    const REVIEWER_OPENCODE_AGENT =
      OPENCODE.files[".work/agents/reviewer.json"] ?? "";
    const manifest = JSON.parse(file(".work/project.json"));
    manifest.environments.review.connections = {
      ...manifest.environments.review.connections,
      ...JSON.parse(`{${OPENCODE_BINDING}}`),
    };
    const policy = parseProjectEnvironmentPolicy(manifest);
    expect(policy.invalid).toBeUndefined();
    expect(policy.environments.review?.connections?.model).toMatchObject({
      principal: "service",
      model: { allow: ["deepseek/deepseek-v4.1-flash"] },
    });
    const agent = agentDefinitionSchema().safeParse(
      JSON.parse(REVIEWER_OPENCODE_AGENT),
    );
    expect(agent.success, JSON.stringify(agent.error)).toBe(true);
    expect(agent.data).toMatchObject({
      kind: "acp",
      acp: { command: ["opencode", "acp"] },
      credentials: { source: "connection", connection: "model" },
      sandboxing: "contained",
      environment: { allowed: ["review"] },
    });
    // OpenCode's configuration names the model the agent chooses, and the
    // image keeps the pull request's own configuration out.
    expect(REVIEW_OPENCODE_DOCKERFILE).toMatch(
      /^FROM docker:[\w.-]+-dind@sha256:[a-f0-9]{64}$/m,
    );
    expect(REVIEW_OPENCODE_DOCKERFILE).toContain(
      `"model": "work/${agent.data?.model}"`,
    );
    expect(REVIEW_OPENCODE_DOCKERFILE).toContain(
      "OPENCODE_DISABLE_PROJECT_CONFIG=1",
    );
  });

  it("parses as four workflows on the GitHub library and session events", () => {
    const parsed = parseProject({
      ".work/triggers/github.ts": file(".work/triggers/github.ts"),
      ".work/workflows/src/reviews.ts": file(".work/workflows/src/reviews.ts"),
      ".work/workflows/src/review-report.ts": file(
        ".work/workflows/src/review-report.ts",
      ),
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.secrets.map((secret) => secret.name)).toEqual([
      "GITHUB_WEBHOOK_SECRET",
    ]);
    const workflows = Object.fromEntries(
      parsed.workflows.map((workflow) => [workflow.functionName, workflow]),
    );
    const bindings = (name: string) =>
      workflows[name]?.graph.triggers.map((binding) => binding.kind);
    expect(bindings("reviewPullRequests")).toEqual(["github.pull_request"]);
    expect(bindings("answerReviewComments")).toEqual([
      "github.issue_comment",
      "github.pull_request_review_comment",
    ]);
    expect(bindings("closePullRequestChats")).toEqual(["github.pull_request"]);
    expect(bindings("postReviews")).toEqual(["session.turn-changed"]);
    // Only the poster holds a connection; the chat's comes from its
    // Environment.
    for (const workflow of parsed.workflows)
      expect(workflow.graph.connections.map((entry) => entry.alias)).toEqual(
        workflow.functionName === "postReviews" ? ["github"] : [],
      );
    expect(workflows.postReviews?.graph.triggers[0]?.config).toEqual({
      statuses: ["completed", "failed", "interrupted"],
    });
    // One publication per pull request chat at a time (ADR 0325).
    expect(workflows.postReviews?.graph.concurrency).toEqual({
      key: "payload.session.key",
      onConflict: "queue",
    });
    for (const name of [
      "reviewPullRequests",
      "answerReviewComments",
      "closePullRequestChats",
    ])
      expect(workflows[name]?.graph.concurrency, name).toBeUndefined();

    // Filters decide which events start runs, before any project code.
    const starts = (name: string, event: unknown) =>
      (workflows[name]?.graph.triggers ?? []).some((binding) =>
        matchesAllWhere(
          binding.where === undefined ? [] : [binding.where],
          event,
        ),
      );
    for (const action of [
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
    ])
      expect(
        starts("reviewPullRequests", pullRequest({ action })),
        action,
      ).toBe(true);
    expect(
      starts(
        "reviewPullRequests",
        pullRequest({ action: "opened", draft: true }),
      ),
    ).toBe(false);
    expect(
      starts("reviewPullRequests", pullRequest({ action: "closed" })),
    ).toBe(false);
    expect(
      starts("closePullRequestChats", pullRequest({ action: "closed" })),
    ).toBe(true);
    expect(
      starts("answerReviewComments", comment({ body: "@work why?" })),
    ).toBe(true);
    expect(
      starts(
        "answerReviewComments",
        comment({ body: "@work why?", type: "Bot" }),
      ),
    ).toBe(false);
    // The App's webhook also delivers other repositories' events; the
    // workspace fetches from the project's remote, so they start nothing.
    const elsewhere = "acme/payments";
    expect(
      starts(
        "reviewPullRequests",
        pullRequest({ action: "opened", repository: elsewhere }),
      ),
    ).toBe(false);
    expect(
      starts(
        "closePullRequestChats",
        pullRequest({ action: "closed", repository: elsewhere }),
      ),
    ).toBe(false);
    for (const inline of [false, true])
      expect(
        starts(
          "answerReviewComments",
          comment({ body: "@work why?", inline, repository: elsewhere }),
        ),
      ).toBe(false);
    // The poster hears only this repository's review chats.
    expect(starts("postReviews", turnEvent({ key: "pr-acme/web-42" }))).toBe(
      true,
    );
    for (const key of ["pr-acme/payments-42", "slack:C1:1.2", null])
      expect(starts("postReviews", turnEvent({ key })), String(key)).toBe(
        false,
      );
  });

  it("parses the optional stall workflow on session.turn-stalled for this repository's chats", () => {
    const parsed = parseProject({
      ".work/workflows/src/stalled-reviews.ts": file(
        ".work/workflows/src/stalled-reviews.ts",
      ),
    });
    expect(parsed.errors).toEqual([]);
    const [workflow, ...others] = parsed.workflows;
    expect(others).toEqual([]);
    expect(workflow?.functionName).toBe("restartStalledReviews");
    expect(workflow?.graph.triggers.map((binding) => binding.kind)).toEqual([
      "session.turn-stalled",
    ]);
    expect(workflow?.graph.concurrency).toEqual({
      key: "payload.session.key",
      onConflict: "queue",
    });
    const starts = (event: unknown) =>
      (workflow?.graph.triggers ?? []).some((binding) =>
        matchesAllWhere(
          binding.where === undefined ? [] : [binding.where],
          event,
        ),
      );
    const stall = { attemptId: "a", attempt: 1, restarts: 0 };
    expect(starts(stallEvent(stall))).toBe(true);
    for (const key of ["pr-acme/payments-42", null])
      expect(starts(stallEvent({ ...stall, key })), String(key)).toBe(false);
    // The reviewers set a threshold, or no stall is ever recorded.
    for (const reviewer of [
      JSON.parse(file(".work/agents/reviewer.json")),
      JSON.parse(OPENCODE.files[".work/agents/reviewer.json"] ?? "{}"),
    ])
      expect(reviewer.stall).toEqual({ minutes: 20 });
  });

  it("restarts a stalled review with its evidence kept, and stops it at the bound", async () => {
    const event = stallEvent({
      attemptId: "attempt-1",
      attempt: 1,
      restarts: 0,
    });
    const outcome = await runStalled(`
      const EVENT = ${JSON.stringify(event)};
      const stall = (attempt, restarts) => ({ ...EVENT, payload: { ...EVENT.payload, detail: { ...EVENT.payload.detail, attemptId: "attempt-" + attempt, attempt, attempts: attempt, restarts } } });
      const results = [];
      results.push(await runWorkflow(restartStalledReviews, stall(1, 0), context));
      // Run again after its restart ran: that attempt is gone, so nothing.
      results.push(await runWorkflow(restartStalledReviews, stall(1, 0), context));
      results.push(await runWorkflow(restartStalledReviews, stall(2, 1), context));
      // Past the bound: this turn, and only this turn, is stopped instead.
      results.push(await runWorkflow(restartStalledReviews, stall(3, 2), context));
      console.log(JSON.stringify({ results, log, evidence: written["store/reviews/stalls/42/attempt-1.json"] }));
    `);
    const restarted = (attempt: number) => [
      ["inspect"],
      ["attempts", "t1"],
      ["write", `store/reviews/stalls/42/attempt-${attempt}.json`],
      ["inspect"],
      [
        "restart",
        `attempt-${attempt}`,
        true,
        `stall:attempt-${attempt}`,
        "no progress for 20 minutes while running mcp__github__get",
      ],
    ];
    expect(outcome).toMatchObject({
      results: [
        { act: "restart", attempt: 1 },
        // Retried after the restart ran: that attempt is gone, so nothing.
        { act: "nothing", attempt: 1 },
        { act: "restart", attempt: 2 },
        { act: "stop", attempt: 3 },
      ],
      log: [
        ...restarted(1),
        ["inspect"],
        ...restarted(2),
        ["inspect"],
        ["attempts", "t1"],
        ["write", "store/reviews/stalls/42/attempt-3.json"],
        ["inspect"],
        ["interrupt", "t1", "stall:t1:stop"],
      ],
      evidence: {
        act: "restart",
        attempts: [
          { diagnostics: { harness: "[warn] opencode: waiting on a tool" } },
        ],
      },
    });
  });

  it("leaves look-alike chats, turns that moved on, and refused restarts alone", async () => {
    const event = stallEvent({
      attemptId: "attempt-1",
      attempt: 1,
      restarts: 0,
    });
    const outcome = await runStalled(`
      const EVENT = ${JSON.stringify(event)};
      const keyed = (key) => ({ ...EVENT, payload: { ...EVENT.payload, session: { ...EVENT.payload.session, key } } });
      const results = {};
      // Another repository's key that the trigger's prefix also matches.
      results.lookAlike = await runWorkflow(restartStalledReviews, keyed("pr-acme/web-tools-3"), context);
      // A chat with this key that reviewPullRequests did not start.
      chat.keyWorkflows = [];
      results.notOurs = await runWorkflow(restartStalledReviews, EVENT, context);
      chat.keyWorkflows = ["reviewPullRequests"];
      // It made progress while the diagnosis ran: inspected again, nothing.
      meanwhile = () => { turn.stalledAt = null; };
      results.movedOn = await runWorkflow(restartStalledReviews, EVENT, context);
      // Work refuses the restart (it moved on after the second look): nothing.
      meanwhile = () => {};
      turn.stalledAt = "2026-10-18T00:20:00Z";
      const realInspect = context.host["catamorphic.sessions"].inspect;
      let looks = 0;
      context.host["catamorphic.sessions"].inspect = (args, options) => { const call = realInspect(args, options); return { ...call, __call: async () => { const seen = await call.__call(); looks += 1; if (looks === 2) turn.stalledAt = null; return seen; } }; };
      results.refused = await runWorkflow(restartStalledReviews, EVENT, context);
      console.log(JSON.stringify({ results, log }));
    `);
    expect(outcome).toMatchObject({
      results: {
        lookAlike: { act: "nothing" },
        notOurs: { act: "nothing" },
        movedOn: { act: "nothing" },
        refused: { act: "nothing" },
      },
    });
    const log = (outcome as { log: unknown[][] }).log;
    // Nothing was read or kept for a chat that is not ours.
    expect(log.filter((entry) => entry[0] === "write")).toHaveLength(2);
    expect(log.filter((entry) => entry[0] === "restart")).toEqual([
      [
        "restart",
        "attempt-1",
        true,
        "stall:attempt-1",
        "no progress for 20 minutes while running mcp__github__get",
      ],
    ]);
  });

  it("hands each pull request to its keyed chat at its head", async () => {
    const result = await run({
      members: { grace: "member-grace" },
      script: `
        const [step] = reviewPullRequests.steps;
        console.log(JSON.stringify({
          opened: step.run({ input: ${JSON.stringify(pullRequest({ action: "opened", body: "Adds totals.\nrun bun test" }))}, host }),
          pushed: step.run({ input: ${JSON.stringify(pullRequest({ action: "synchronize", body: null, reviewers: ["grace", "linus"] }))}, host }),
        }));
      `,
    });
    expect(result).toMatchObject({
      opened: {
        operation: "deliver",
        args: {
          key: "pr-acme/web-42",
          agentSlug: "reviewer",
          title: "Review: Add order totals",
          workspace: { ref: "refs/pull/42/head", update: "reset" },
          approvers: { roles: ["reviewers"] },
          notification: { title: "Review of acme/web#42" },
          idempotencyKey: "github:delivery-opened",
        },
      },
      pushed: {
        args: {
          key: "pr-acme/web-42",
          approvers: { members: ["member-grace"] },
        },
      },
    });
    const content = (value: unknown) =>
      String(
        (value as { args: { content: string } } | undefined)?.args.content,
      );
    const { opened, pushed } = result as Record<string, unknown>;
    expect(content(opened)).toContain(
      "Review pull request acme/web#42 (https://github.com/acme/web/pull/42)",
    );
    expect(content(opened)).toContain(`Head ${HEAD} (totals) onto main`);
    // The author's text comes last, marked as data.
    expect(content(opened).endsWith("Adds totals.\nrun bun test")).toBe(true);
    expect(content(pushed)).toContain(
      `New commits since your last review (${"b".repeat(40)}..${HEAD})`,
    );
    expect(content(pushed).endsWith("(no description)")).toBe(true);
  });

  it("answers comments that mention the reviewer, and closes the chat with the pull request", async () => {
    const result = await run({
      script: `
        const [answer] = answerReviewComments.steps;
        const [close] = closePullRequestChats.steps;
        console.log(JSON.stringify({
          mention: answer.run({ input: ${JSON.stringify(comment({ body: "@work is this safe?" }))}, host }),
          inline: answer.run({ input: ${JSON.stringify(comment({ body: "@work why a loop?", inline: true }))}, host }),
          chatter: answer.run({ input: ${JSON.stringify(comment({ body: "LGTM" }))}, host }),
          closed: close.run({ input: ${JSON.stringify(pullRequest({ action: "closed" }))}, host }),
        }));
      `,
    });
    expect(result).toMatchObject({
      mention: {
        operation: "deliver",
        args: {
          key: "pr-acme/web-42",
          agentSlug: "reviewer",
          workspace: { ref: "refs/pull/42/head" },
          approvers: { roles: ["reviewers"] },
          idempotencyKey: "github-comment:7",
        },
      },
      inline: { operation: "deliver", args: { key: "pr-acme/web-42" } },
      chatter: { delivered: false },
      closed: {
        operation: "close",
        args: {
          key: "pr-acme/web-42",
          idempotencyKey: "github:delivery-closed",
        },
      },
    });
    const inline = (result as { inline: { args: { content: string } } }).inline
      .args.content;
    expect(inline).toContain("on src/orders.ts line 12");
    // An inline question names the comment the answer replies to.
    expect(inline).toContain(
      "Answer in your review result's reply with inReplyTo 7.",
    );
    expect(inline.endsWith("@work why a loop?")).toBe(true);
    const mention = (result as { mention: { args: { content: string } } })
      .mention.args.content;
    expect(mention).toContain("Answer in your review result's reply. ");
  });
});

describe("postReviews", () => {
  const OTHER = "d".repeat(40);
  const posted = (metadata: Record<string, unknown>) =>
    (metadata["review.posted"] as Array<{ effect: string }> | undefined)?.map(
      (entry) => entry.effect,
    );
  /** Runs overlapping publications in a fake world and reports what GitHub got. */
  const publish = (script: string) =>
    run({
      script: `
      const world = fakeWorld({ head: ${JSON.stringify(HEAD)} });
      const event = (turnId, status = "completed") => ({
        ...${JSON.stringify(turnEvent({ key: "pr-acme/web-42" }))},
        payload: { ...${JSON.stringify(turnEvent({ key: "pr-acme/web-42" }).payload)}, detail: { turnId, messageId: "input-" + turnId, status } },
      });
      const outcomes = await (async () => { ${script} })();
      console.log(JSON.stringify({ outcomes, writes: world.github.writes, checks: world.github.checks.map(run => run.conclusion), metadata: world.chat.metadata }));
    `,
    }) as Promise<{
      outcomes: unknown;
      writes: string[];
      checks: string[];
      metadata: Record<string, unknown>;
    }>;

  it("serializes overlapping failure and success turns: no later success, no weaker review", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.submit("t2", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      return runOverlapping(postReviews, [event("t1"), event("t2")], world.context);
    `);
    expect(result.writes).toEqual(["check:failure", "review:REQUEST_CHANGES"]);
    expect(result.metadata["review.verdicts"]).toEqual([
      { commit: HEAD, verdict: "failure" },
    ]);
    expect(posted(result.metadata)).toEqual([
      "work-review:t1:check",
      "work-review:t1:review",
    ]);
    expect(result.outcomes).toEqual([
      { posted: "review", verdict: "failure", problem: null },
      { posted: "review", verdict: "failure", problem: null },
    ]);
  });

  it("tightens a commit's success to a failure, and a missing review never loosens it", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.submit("t2", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      return runOverlapping(postReviews, [event("t1"), event("t2"), event("t3", "failed")], world.context);
    `);
    expect(result.checks).toEqual(["success", "failure"]);
    expect(result.writes).toEqual([
      "check:success",
      "review:COMMENT",
      "check:failure",
      "review:REQUEST_CHANGES",
    ]);
    expect(result.metadata["review.verdicts"]).toEqual([
      { commit: HEAD, verdict: "failure" },
    ]);
  });

  it("finds a write GitHub accepted when its answer was lost, and posts it once", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)}, reply: { body: "Because @team said so <!-- x -->" } });
      world.github.loseNextAnswer.add("create_check_run");
      world.github.loseNextAnswer.add("create_review");
      world.github.loseNextAnswer.add("issue_comment");
      const first = await runWorkflow(postReviews, event("t1"), world.context);
      // A rerun of the same turn finds everything on the chat and in GitHub.
      const again = await runWorkflow(postReviews, event("t1"), world.context);
      return [first, again, world.github.comments.map(entry => entry.body)];
    `);
    expect(result.writes).toEqual([
      "check:failure",
      "review:REQUEST_CHANGES",
      "comment",
    ]);
    const [, , bodies] = result.outcomes as [unknown, unknown, string[]];
    // Mentions and hidden markers from the report are defused; the stamp is ours.
    expect(bodies[0]).not.toContain("@team");
    expect(bodies[0]).not.toContain("<!-- x -->");
    expect(bodies[0]).toContain("<!-- work-review:t1:reply -->");
    expect(posted(result.metadata)).toEqual([
      "work-review:t1:check",
      "work-review:t1:review",
      "work-review:t1:reply",
    ]);
  });

  it("refuses a review naming another commit, or whose turn began on one, and says which", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(OTHER)} });
      const named = await runWorkflow(postReviews, event("t1"), world.context);
      world.submit("t2", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)}, turnCommit: ${JSON.stringify(OTHER)} });
      const began = await runWorkflow(postReviews, event("t2"), world.context);
      world.submit("t3", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)}, turnCommit: null });
      const unrecorded = await runWorkflow(postReviews, event("t3"), world.context);
      return [named, began, unrecorded, world.github.checks.map((run) => run.conclusion)];
    `);
    const [named, began, unrecorded] = result.outcomes as unknown[];
    expect(named).toEqual({
      posted: "missing",
      verdict: "action_required",
      problem: "The review names commit ddddddd, not the head aaaaaaa.",
    });
    expect(began).toEqual({
      posted: "missing",
      verdict: "action_required",
      problem:
        "The review's turn began on commit ddddddd, not the head aaaaaaa.",
    });
    expect(unrecorded).toMatchObject({
      posted: "missing",
      problem: "Work recorded no commit for the review's turn.",
    });
    // A refused review never passes the commit, and no review was posted.
    expect(result.writes).toEqual(["check:action_required"]);
  });

  it("publishes the turn's newest review from any attempt", async () => {
    const result = await publish(`
      // Attempt 1 submits and its sandbox is lost; attempt 2 ends the turn
      // without submitting again: attempt 1's review is the turn's.
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)}, attemptId: "t1-attempt-1" });
      const lost = await runWorkflow(postReviews, event("t1"), world.context);
      // Of two reviews in one turn, the newer is the turn's answer.
      world.submit("t2", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)}, attemptId: "t2-attempt-1", reply: { body: "first" } });
      world.submit("t2", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)}, attemptId: "t2-attempt-2", reply: { body: "second" } });
      const newest = await runWorkflow(postReviews, event("t2"), world.context);
      return [lost, newest, world.github.comments.map((entry) => entry.body.split("\\n")[0])];
    `);
    const [lost, , bodies] = result.outcomes as [unknown, unknown, string[]];
    expect(lost).toEqual({
      posted: "review",
      verdict: "failure",
      problem: null,
    });
    expect(result.writes).toEqual([
      "check:failure",
      "review:REQUEST_CHANGES",
      "comment",
    ]);
    expect(bodies).toEqual(["second"]);
  });

  it("publishes the turn's own review though a comment reached the chat since, and many newer reviews exist", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      // An @work comment arrived before this queued publication ran, and
      // later turns submitted many reviews of their own.
      world.requestArrived();
      for (let turn = 2; turn <= 25; turn += 1)
        world.submit("t" + turn, { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      return runWorkflow(postReviews, event("t1"), world.context);
    `);
    expect(result.outcomes).toEqual({
      posted: "review",
      verdict: "failure",
      problem: null,
    });
    expect(result.writes).toEqual(["check:failure", "review:REQUEST_CHANGES"]);
  });

  it("keeps the chat's record newest last, whatever order its commits sort in", async () => {
    const LATER = "0".repeat(40);
    const result = await publish(`
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      await runWorkflow(postReviews, event("t1"), world.context);
      // A push to a head that sorts before the first.
      world.github.head = ${JSON.stringify(LATER)};
      world.chat.commit = ${JSON.stringify(LATER)};
      world.submit("t2", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(LATER)} });
      return runWorkflow(postReviews, event("t2"), world.context);
    `);
    expect(result.metadata["review.verdicts"]).toEqual([
      { commit: HEAD, verdict: "failure" },
      { commit: LATER, verdict: "success" },
    ]);
  });

  it("posts nothing once the head moves past the chat, and marks a missing review once", async () => {
    const result = await publish(`
      world.submit("t2", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.github.head = ${JSON.stringify(OTHER)};
      const moved = await runWorkflow(postReviews, event("t2"), world.context);
      world.github.head = ${JSON.stringify(HEAD)};
      const missing = await runOverlapping(postReviews, [event("t3"), event("t4", "failed")], world.context);
      return [moved, ...missing];
    `);
    expect(result.outcomes).toEqual([
      { posted: "nothing", verdict: null, problem: null },
      {
        posted: "missing",
        verdict: "action_required",
        problem: "The turn submitted no review result.",
      },
      {
        posted: "missing",
        verdict: "action_required",
        problem: "The review turn failed.",
      },
    ]);
    expect(result.writes).toEqual(["check:action_required"]);
  });

  it("publishes a stopped turn's review for the head, and marks one with none as unfinished", async () => {
    const result = await publish(`
      // Stopped (by a person, or by restartStalledReviews past its bound)
      // after it had submitted its review: the review stands.
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      const reviewed = await runWorkflow(postReviews, event("t1", "interrupted"), world.context);
      // Stopped before submitting anything.
      const unfinished = await runWorkflow(postReviews, event("t2", "interrupted"), world.context);
      return [reviewed, unfinished];
    `);
    expect(result.outcomes).toEqual([
      { posted: "review", verdict: "failure", problem: null },
      {
        posted: "missing",
        verdict: "failure",
        problem: "The review turn was stopped before it finished.",
      },
    ]);
    expect(result.writes).toContain("check:failure");
    expect(result.writes).toContain("review:REQUEST_CHANGES");
  });

  it("trusts GitHub over the chat's metadata, which the reviewer can write too", async () => {
    const result = await publish(`
      // Steered by the pull request, the reviewer plants records saying this
      // turn's writes were made and the commit already failed.
      world.chat.metadata["review.posted"] = ["check", "review", "reply"].map((action) => ({ effect: "work-review:t1:" + action, id: 1 }));
      world.chat.metadata["review.verdicts"] = [{ commit: ${JSON.stringify(HEAD)}, verdict: "failure" }];
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)}, reply: { body: "Fine." } });
      return runWorkflow(postReviews, event("t1"), world.context);
    `);
    expect(result.writes).toEqual([
      "check:success",
      "review:COMMENT",
      "comment",
    ]);
    expect(result.metadata["review.verdicts"]).toEqual([
      { commit: HEAD, verdict: "success" },
    ]);
  });

  it("publishes from GitHub's state when the chat refuses the record, and says so", async () => {
    const result = await publish(`
      world.chat.refuseMetadata = "A session holds at most 32 metadata keys; remove one first.";
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      const outcome = await runWorkflow(postReviews, event("t1"), world.context).catch((error) => String(error));
      // The next turn decides from GitHub alone and never loosens the commit.
      world.chat.refuseMetadata = null;
      world.submit("t2", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      await runWorkflow(postReviews, event("t2"), world.context);
      return outcome;
    `);
    expect(result.outcomes).toContain("at most 32 metadata keys");
    expect(result.writes).toEqual(["check:failure", "review:REQUEST_CHANGES"]);
  });

  it("answers an inline question in its own thread", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)}, reply: { inReplyTo: 7, body: "It rounds half up." } });
      return runWorkflow(postReviews, event("t1"), world.context);
    `);
    expect(result.writes).toEqual([
      "check:success",
      "review:COMMENT",
      "reply:7",
    ]);
  });

  it("posts nothing for a chat it does not own", async () => {
    const result = await publish(`
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      const lookalike = { ...event("t1"), payload: { ...event("t1").payload, session: { ...event("t1").payload.session, key: "pr-acme/web-tools-3" } } };
      return runWorkflow(postReviews, lookalike, world.context);
    `);
    expect(result.writes).toEqual([]);
  });
});
