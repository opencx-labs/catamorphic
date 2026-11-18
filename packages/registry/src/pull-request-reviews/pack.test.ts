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
import {
  checkFinding,
  checkWorkReview,
  findingComment,
  findingLine,
  findingMarker,
  publicationText,
} from "./review-report.js";

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
      import { fakeWorld, runOverlapping, runWorkflow, workflowQueue } from "./harness.ts";
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
      // The pull request's code runs apart from the reviewer, reaching only
      // Git reads through the gateway (ADR 0332).
      commands: { separate: true, connections: ["git"] },
      setup: {
        network: { allow: expect.arrayContaining(["registry.npmjs.org"]) },
      },
      waitMinutes: 30,
      approvals: { waitMinutes: 60 },
    });
    expect(review?.volumes).toBeUndefined();
    // A pnpm store filled from main, mounted read only (ADR 0334): setup
    // installs from it offline and falls back to the registries.
    expect(review?.caches).toEqual({
      pnpm: {
        path: "~/.cache/work/pnpm-store",
        sizeMb: 16384,
        fill: {
          command:
            "if [ -f pnpm-lock.yaml ]; then pnpm fetch --store-dir ~/.cache/work/pnpm-store; fi",
          timeoutMinutes: 30,
        },
      },
    });
    // A sandbox that can mount (a review's own Docker) extends the cache in
    // an overlay, so a changed lockfile fetches only what is new; others
    // install offline from it and fall back to the registries.
    const command = review?.setup?.command ?? "";
    expect(command).toContain(
      'mount -t overlay overlay -o "lowerdir=$c,upperdir=$o/up,workdir=$o/work" "$s"',
    );
    expect(command).toContain(
      'pnpm install --frozen-lockfile --prefer-offline --store-dir "$s"',
    );
    expect(command).toContain(
      'pnpm install --frozen-lockfile --offline --store-dir "$c" || pnpm install --frozen-lockfile',
    );
    expect(Object.keys(review?.connections ?? {})).toEqual([
      "github",
      "git",
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
    expect(review?.connections?.github?.capabilities).toEqual(reads);
    // The commands get Git reads of the project's repository alone (its
    // default), through a binding of their own, not the reviewer's GitHub
    // reads (ADR 0332).
    expect(review?.connections?.git).toMatchObject({
      provider: "github",
      principal: "service",
      capabilities: ["git:read"],
    });
    expect(review?.connections?.git?.git).toBeUndefined();
    for (const reviewer of [
      file(".work/agents/reviewer.json"),
      OPENCODE.files[".work/agents/reviewer.json"] ?? "{}",
    ])
      expect(JSON.parse(reviewer).connections).toContainEqual({
        alias: "git",
        principal: "service",
      });
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

  it("declares the review and its findings as typed results both reviewers submit", () => {
    const { review, finding } = JSON.parse(
      file(".work/agents/reviewer.json"),
    ).results;
    expect(review).toBeDefined();
    expect(finding).toBeDefined();
    // The OpenCode reviewer replaces this one: it submits the same results.
    expect(
      JSON.parse(OPENCODE.files[".work/agents/reviewer.json"] ?? "{}").results,
    ).toEqual({ review, finding });
    // The review does not repeat its turn's findings: they post with it.
    const report = {
      reviewedCommit: "a".repeat(40),
      verdict: "COMMENT",
      score: 4,
      summary: "Nothing blocks.",
      checkSummary: "Ran the tests.",
      reply: null,
    };
    expect(checkResultValue({ schema: review, value: report })).toEqual({
      value: report,
    });
    const refused = checkResultValue({
      schema: review,
      value: {
        ...report,
        verdict: "APPROVE",
        score: 0,
        origin: "x",
      },
    });
    expect(
      "errors" in refused && refused.errors.map((error) => error.path),
    ).toEqual(expect.arrayContaining(["/verdict", "/score", ""]));
    expect(
      "errors" in
        checkResultValue({
          schema: review,
          value: { ...report, findings: ["f1"] },
        }),
    ).toBe(true);
    expect(
      "errors" in
        checkResultValue({
          schema: review,
          value: { ...report, comments: [] },
        }),
    ).toBe(true);
    const verified = {
      id: "orders-lock",
      path: "db/0042_orders.sql",
      line: 3,
      startLine: null,
      side: null,
      severity: "blocking",
      title: "Scans 38M rows under a lock",
      body: "Add the constraint NOT VALID, then VALIDATE it.",
    };
    expect(checkResultValue({ schema: finding, value: verified })).toEqual({
      value: verified,
    });
    // Blank as JavaScript reads it (a no-break space, say) is blank to
    // the schema too, so the poster never drops what Work accepted.
    for (const blank of ["\u00a0", "\ufeff\u2028", " \t"])
      expect(
        "errors" in
          checkResultValue({
            schema: finding,
            value: { ...verified, title: blank },
          }),
        JSON.stringify(blank),
      ).toBe(true);
    const unusable = checkResultValue({
      schema: finding,
      value: { ...verified, id: "x -->", severity: "nit" },
    });
    expect(
      "errors" in unusable && unusable.errors.map((error) => error.path),
    ).toEqual(expect.arrayContaining(["/id", "/severity"]));
    // The reviewer is told to submit both, never to end with a block.
    const persona = file(".work/agents/reviewer.md");
    expect(persona).toContain("`submit_result`");
    expect(persona).toContain("name `finding`, before you look for the next");
    expect(persona).toContain("name `review`");
    // A report is a result, never a fenced block.
    expect(persona).not.toMatch(/```work-review/);
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
      acp: {
        command: ["opencode", "acp"],
        env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
      },
      credentials: { source: "connection", connection: "model" },
      sandboxing: "contained",
      environment: { allowed: ["review"] },
    });
    // OpenCode loads plugins from the checkout whatever its settings say,
    // so its definition claims no contract to run apart from the change's
    // code (ADR 0332), Work refuses it where commands run apart, and the
    // pack says to run its Environment's commands beside it.
    expect(agent.data?.acp).not.toHaveProperty("shell");
    expect(agent.data?.acp).not.toHaveProperty("projectConfig");
    expect(OPENCODE.manifest.docs).toContain(
      "Remove `commands` from the `review` Environment",
    );
    expect(OPENCODE.manifest.docs).toContain(
      "not protected from the code they review",
    );
    // OpenCode's configuration names the model the agent chooses, and the
    // image keeps the pull request's own settings out.
    expect(REVIEW_OPENCODE_DOCKERFILE).toMatch(
      /^FROM docker:[\w.-]+-dind@sha256:[a-f0-9]{64}$/m,
    );
    expect(REVIEW_OPENCODE_DOCKERFILE).toContain(
      `"model": "work/${agent.data?.model}"`,
    );
    expect(REVIEW_OPENCODE_DOCKERFILE).toContain(
      "OPENCODE_DISABLE_PROJECT_CONFIG=1",
    );
    // Beside the reviewer, OpenCode starts no language server or formatter
    // (some resolve from the change's dependencies), downloads none, keeps
    // no Git snapshots, and reads none of the change's Claude Code files.
    const config = JSON.parse(
      [...REVIEW_OPENCODE_DOCKERFILE.matchAll(/^\s*'(.*)' (?:\\$|>)/gm)]
        .map((line) => line[1])
        .join("\n"),
    );
    expect(config).toMatchObject({
      lsp: false,
      formatter: false,
      snapshot: false,
    });
    for (const variable of [
      "OPENCODE_DISABLE_LSP_DOWNLOAD=1",
      "OPENCODE_DISABLE_CLAUDE_CODE=1",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS=1",
    ])
      expect(REVIEW_OPENCODE_DOCKERFILE).toContain(variable);
    expect(agent.data?.acp?.env).toMatchObject({
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    });
  });

  it("parses as five workflows on the GitHub library, session events and a schedule", () => {
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
    expect(bindings("postReviews")).toEqual([
      "session.turn-changed",
      "session.result-recorded",
    ]);
    // The cache fills from main on a schedule, needing only caches:write.
    expect(bindings("fillReviewCache")).toEqual(["schedule"]);
    expect(workflows.fillReviewCache?.graph.permissions).toEqual([
      "caches:write",
    ]);
    // Only the poster holds a connection; the chat's comes from its
    // Environment.
    for (const workflow of parsed.workflows)
      expect(workflow.graph.connections.map((entry) => entry.alias)).toEqual(
        workflow.functionName === "postReviews" ? ["github"] : [],
      );
    // A turn at work shows the review in progress; a settled one posts it;
    // each finding posts the moment it is recorded (ADR 0336).
    expect(workflows.postReviews?.graph.triggers[0]?.config).toEqual({
      statuses: [
        "queued",
        "preparing",
        "running",
        "completed",
        "failed",
        "interrupted",
        "cancelled",
      ],
    });
    expect(workflows.postReviews?.graph.triggers[1]?.config).toEqual({
      names: ["finding"],
    });
    // One publication per pull request chat at a time (ADR 0325); a
    // turn's alike events join one still waiting (ADR 0336).
    expect(workflows.postReviews?.graph.concurrency).toEqual({
      key: "payload.session.key",
      onConflict: "queue",
      coalesce: ["kind", "payload.detail.turnId", "payload.detail.status"],
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
    const recorded = (key: string | null) => ({
      ...turnEvent({ key }),
      kind: "session.result-recorded",
    });
    expect(starts("postReviews", recorded("pr-acme/web-42"))).toBe(true);
    expect(starts("postReviews", recorded("pr-acme/payments-42"))).toBe(false);
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
      // A turn's status as Work records it: a queued turn waits in the
      // chat's queue until it works or ends. lateEvent changes nothing.
      let events = 0;
      const lateEvent = (turnId, status = "completed") => ({
        ...${JSON.stringify(turnEvent({ key: "pr-acme/web-42" }))},
        id: "event-" + (events += 1),
        payload: { ...${JSON.stringify(turnEvent({ key: "pr-acme/web-42" }).payload)}, detail: { turnId, messageId: "input-" + turnId, status } },
      });
      const event = (turnId, status = "completed") => {
        world.chat.queued = world.chat.queued.filter((id) => id !== turnId);
        if (status === "queued") world.chat.queued.push(turnId);
        return lateEvent(turnId, status);
      };
      const outcomes = await (async () => { ${script} })();
      console.log(JSON.stringify({
        outcomes,
        writes: world.github.writes,
        checks: world.github.checks.map(run => run.conclusion),
        runs: world.github.checks.map(run => ({ commit: run.headSha.slice(0, 1), status: run.status, conclusion: run.conclusion, title: run.title })),
        summaries: world.github.checks.map(run => run.summary ?? null),
        reviews: world.github.reviews.map(review => ({ body: review.body, comments: review.comments.map(comment => comment.path + ":" + comment.line) })),
        bodies: world.github.reviews.map(review => review.comments.map(comment => comment.body)),
        calls: world.github.calls,
        metadata: world.chat.metadata,
      }));
    `,
    }) as Promise<{
      outcomes: unknown;
      writes: string[];
      checks: string[];
      runs: Array<{
        commit: string;
        status: string;
        conclusion: string | null;
        title: string | null;
      }>;
      reviews: Array<{ body: string; comments: string[] }>;
      bodies: string[][];
      summaries: Array<string | null>;
      calls: number;
      metadata: Record<string, unknown>;
    }>;
  const finding = (id: string) => `<!-- work-review:${HEAD}:finding:${id} -->`;

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

  it("shows a queued review in progress before its turn starts, then its phases, and completes it with the verdict", async () => {
    const result = await publish(`
      // Queued while the chat still waits for its machine: no placement yet.
      world.chat.placement = null;
      const queued = await runWorkflow(postReviews, event("t1", "queued"), world.context);
      world.chat.placement = { environment: "review" };
      world.chat.turn = { id: "t1", status: "preparing" };
      await runWorkflow(postReviews, event("t1", "preparing"), world.context);
      world.chat.turn = { id: "t1", status: "running" };
      await runWorkflow(postReviews, event("t1", "running"), world.context);
      // Running again (after an approval) changes nothing.
      await runWorkflow(postReviews, event("t1", "running"), world.context);
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.chat.turn = null;
      // A status whose run comes after its turn settled leaves the words.
      await runWorkflow(postReviews, event("t1", "preparing"), world.context);
      const settled = await runWorkflow(postReviews, event("t1"), world.context);
      // A question's turn on a commit with a verdict shows nothing in progress.
      await runWorkflow(postReviews, event("t2", "queued"), world.context);
      return [queued, settled];
    `);
    expect(result.writes).toEqual([
      "check:in_progress",
      "update:a:Preparing the workspace",
      "update:a:Reviewing",
      "update:a:failure",
      "review:REQUEST_CHANGES",
    ]);
    // One run per commit: the review's own, completed by its verdict.
    expect(result.runs).toEqual([
      {
        commit: "a",
        status: "completed",
        conclusion: "failure",
        title: "Changes requested (score 2/5)",
      },
    ]);
    expect(result.outcomes).toEqual([
      { posted: "progress", verdict: null, problem: null },
      { posted: "review", verdict: "failure", problem: null },
    ]);
    expect(result.metadata["review.progress"]).toEqual({
      commit: HEAD,
      id: 100,
    });
    expect(posted(result.metadata)).toEqual([
      "work-review:t1:check",
      "work-review:t1:review",
    ]);
  });

  it("says first that a review waits to start", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t1", "queued"), world.context);
      return world.github.checks.map((run) => run.title);
    `);
    expect(result.outcomes).toEqual(["Waiting to start"]);
  });

  it("posts findings the moment they are recorded, once each, across a retried run, a resubmission and the turn's review", async () => {
    const result = await publish(`
      world.chat.turn = { id: "t1", status: "running" };
      const first = await runWorkflow(postReviews, world.find("t1", { id: "f1", line: 2 }), world.context);
      // GitHub accepts the second, and its answer is lost: the retry finds it.
      world.github.loseNextAnswer.add("create_review");
      await runWorkflow(postReviews, world.find("t1", { id: "f2", line: 1, severity: "minor" }), world.context);
      // A posting run delivered again, and a hand-off submitting f1 again.
      await runWorkflow(postReviews, world.find("t1", { id: "f1", line: 2 }), world.context);
      // Outside the diff: it waits for the review, which lists it.
      const outside = await runWorkflow(postReviews, world.find("t1", { id: "f3", line: 40 }), world.context);
      // Recorded, but its posting run never ran (its queue was full).
      world.find("t1", { id: "f4", line: 2, startLine: 1 });
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.chat.turn = null;
      const settled = await runWorkflow(postReviews, event("t1"), world.context);
      // The same turn published again finds everything on GitHub.
      await runWorkflow(postReviews, event("t1"), world.context);
      return [first, outside, settled];
    `);
    expect(result.writes).toEqual([
      "review:COMMENT:src/orders.ts:2",
      "review:COMMENT:src/orders.ts:1",
      "check:failure",
      "review:REQUEST_CHANGES:src/orders.ts:2",
    ]);
    const [first, outside, settled] = result.outcomes as unknown[];
    expect(first).toEqual({ posted: "finding", verdict: null, problem: null });
    expect(outside).toEqual({
      posted: "nothing",
      verdict: null,
      problem:
        "Its findings are posted, or outside the diff for the turn's review to list.",
    });
    expect(settled).toEqual({
      posted: "review",
      verdict: "failure",
      problem: null,
    });
    const [one, two, review] = result.reviews;
    // A finding's own review is its marker; its comment says what it is,
    // and carries the marker so a resumed reviewer sees it in the threads.
    expect(one?.body).toBe(finding("f1"));
    expect(two?.body).toBe(finding("f2"));
    expect(result.bodies[0]).toEqual([
      `**Blocking:** Finding f1\n\nWhy f1 is wrong.\n\n${finding("f1")}`,
    ]);
    // The review carries what was left: f4 inline, f3 in its body, and
    // both markers; never f1 or f2 again.
    expect(review?.comments).toEqual(["src/orders.ts:2"]);
    expect(review?.body).toContain("On lines outside the diff:");
    expect(review?.body).toContain(
      "src/orders\\.ts:40: **Blocking:** Finding f3",
    );
    expect(review?.body).toContain(finding("f3"));
    expect(review?.body).toContain(finding("f4"));
    expect(review?.body).not.toContain(finding("f1"));
    expect(review?.body.endsWith("<!-- work-review:t1:review -->")).toBe(true);
    expect(posted(result.metadata)).toEqual([
      `work-review:${HEAD}:finding:f1`,
      `work-review:${HEAD}:finding:f2`,
      "work-review:t1:check",
      `work-review:${HEAD}:finding:f4`,
      `work-review:${HEAD}:finding:f3`,
      "work-review:t1:review",
    ]);
  });

  it("posts at most 30 findings on a commit mid-turn, leaving the rest to the review", async () => {
    const result = await publish(`
      for (let index = 1; index <= 31; index += 1)
        await runWorkflow(postReviews, world.find("t1", { id: "f" + index, line: 2 }), world.context);
      return world.github.reviews.length;
    `);
    expect(result.outcomes).toBe(30);
  });

  it("never posts a stale finding, and the review that names it posts it", async () => {
    const result = await publish(`
      const asked = world.find("t1", { id: "asked", line: 2 });
      // A question reached the chat before its posting run: it answers an
      // older request now.
      world.requestArrived();
      const stale = await runWorkflow(postReviews, asked, world.context);
      // Found on a commit the head has left.
      const left = await runWorkflow(postReviews, world.find("t1", { id: "old", turnCommit: ${JSON.stringify(OTHER)} }), world.context);
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      await runWorkflow(postReviews, event("t1"), world.context);
      return [stale, left];
    `);
    const [stale, left] = result.outcomes as unknown[];
    expect(stale).toMatchObject({ posted: "nothing" });
    expect(left).toMatchObject({ posted: "nothing" });
    expect(result.writes).toEqual([
      "check:success",
      "review:COMMENT:src/orders.ts:2",
    ]);
    expect(result.reviews[0]?.body).toContain(finding("asked"));
    expect(result.reviews[0]?.body).not.toContain(":finding:old");
  });

  it("cancels a superseded head's check and posts nothing more for it", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t1", "queued"), world.context);
      world.chat.turn = { id: "t1", status: "running" };
      await runWorkflow(postReviews, world.find("t1", { id: "f1", line: 2 }), world.context);
      // A push: GitHub's head moves, and its delivery queues a turn.
      world.github.head = ${JSON.stringify(OTHER)};
      const queued = await runWorkflow(postReviews, event("t2", "queued"), world.context);
      // The old head's turn goes on, and nothing more of it posts.
      const late = await runWorkflow(postReviews, world.find("t1", { id: "f2", line: 1 }), world.context);
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.chat.turn = { id: "t2", status: "preparing" };
      const settled = await runWorkflow(postReviews, event("t1"), world.context);
      return [queued, late, settled];
    `);
    expect(result.writes).toEqual([
      "check:in_progress",
      "review:COMMENT:src/orders.ts:2",
      "check:in_progress",
      "update:a:cancelled",
    ]);
    expect(result.runs).toEqual([
      {
        commit: "a",
        status: "completed",
        conclusion: "cancelled",
        title: "Superseded",
      },
      {
        commit: "d",
        status: "in_progress",
        conclusion: null,
        title: "Waiting to start",
      },
    ]);
    const [, late, settled] = result.outcomes as unknown[];
    expect(late).toMatchObject({ posted: "nothing" });
    expect(settled).toMatchObject({ posted: "nothing" });
    expect(result.metadata["review.progress"]).toEqual({
      commit: OTHER,
      id: 102,
    });
  });

  it("lets a newer turn speak for the head: a stale settle never completes its check", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t2", "queued"), world.context);
      // The earlier turn settles with nothing after the workspace moved on
      // and the next turn already works.
      world.chat.turn = { id: "t2", status: "running" };
      const stale = await runWorkflow(postReviews, event("t1", "failed"), world.context);
      return stale;
    `);
    expect(result.outcomes).toEqual({
      posted: "nothing",
      verdict: null,
      problem: "The review turn failed.",
    });
    expect(result.runs).toEqual([
      {
        commit: "a",
        status: "in_progress",
        conclusion: null,
        title: "Waiting to start",
      },
    ]);
  });

  it("cancels the head's check when the pull request closes before the review finished", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t1", "queued"), world.context);
      world.github.state = "closed";
      return runWorkflow(postReviews, event("t1", "cancelled"), world.context);
    `);
    expect(result.writes).toEqual(["check:in_progress", "update:a:cancelled"]);
    expect(result.runs[0]).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      title: "Not reviewed",
    });
    expect(result.outcomes).toMatchObject({ posted: "nothing" });
  });

  it("follows the chat's progress record only to the App's own run of this pull request", async () => {
    const result = await publish(`
      // Planted by the reviewer: another pull request's run in progress on
      // another commit, and another app's run with this one's id.
      world.github.checks.push(
        { id: 7, own: true, status: "in_progress", conclusion: null, externalId: "work-review:43:progress", headSha: ${JSON.stringify(OTHER)}, title: "Reviewing" },
        { id: 8, own: false, status: "in_progress", conclusion: null, externalId: "work-review:42:progress", headSha: ${JSON.stringify(OTHER)}, title: "Reviewing" },
      );
      world.chat.metadata["review.progress"] = { commit: ${JSON.stringify(OTHER)}, id: 7 };
      return runWorkflow(postReviews, event("t1", "queued"), world.context);
    `);
    expect(result.writes).toEqual(["check:in_progress"]);
    expect(result.runs.map((run) => run.status)).toEqual([
      "in_progress",
      "in_progress",
      "in_progress",
    ]);
  });

  it("never fills the queue with a flood of findings: the verdict posts, the first 30 post once, and the rest are counted", async () => {
    const result = await publish(`
      world.chat.turn = { id: "t1", status: "running" };
      const queue = workflowQueue(postReviews, world.context);
      const delivered = [];
      // Hundreds of findings arrive while the first publication runs.
      for (let index = 0; index < 400; index += 1)
        delivered.push(queue.deliver(world.find("t1", { id: "f" + index, line: 2 })));
      world.submit("t1", { verdict: "REQUEST_CHANGES", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.chat.turn = null;
      delivered.push(queue.deliver(event("t1")));
      const { outcomes, refused } = await queue.drain();
      return { delivered: [...new Set(delivered)], runs: outcomes.length, refused: refused.length, last: outcomes.at(-1) };
    `);
    const outcome = result.outcomes as {
      delivered: string[];
      runs: number;
      refused: number;
      last: unknown;
    };
    // One run waits for every finding; the turn's verdict is never refused.
    expect(outcome.delivered).toEqual(["started", "queued", "joined"]);
    expect(outcome).toMatchObject({ runs: 3, refused: 0 });
    expect(outcome.last).toEqual({
      posted: "review",
      verdict: "failure",
      problem: null,
    });
    // The first publication posts the turn's first 30 in one review; the
    // one that joined finds them decided and calls GitHub not at all.
    const markers = result.reviews.flatMap(
      (review) => review.body.match(/:finding:f\d+ -->/g) ?? [],
    );
    expect(markers).toHaveLength(30);
    expect(markers).toContain(":finding:f29 -->");
    expect(result.writes).toHaveLength(3);
    expect(result.calls).toBeLessThanOrEqual(12);
    // The rest are counted, where people look: the review and the check.
    const note = "At least 70 more findings were not posted";
    expect(result.reviews.at(-1)?.body).toContain(note);
    expect(result.summaries[0]).toContain(note);
  });

  it("answers findings whose events join out of order: a publication takes nothing from its event", async () => {
    const result = await publish(`
      world.chat.turn = { id: "t1", status: "running" };
      const queue = workflowQueue(postReviews, world.context);
      // The first publication reads f0 alone, then waits on GitHub.
      let release;
      world.github.gate = new Promise((resolve) => { release = resolve; });
      queue.deliver(world.find("t1", { id: "f0", line: 2 }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      // f2 then f5 are recorded; their events arrive the other way round.
      const two = world.find("t1", { id: "f2", line: 1 });
      const five = world.find("t1", { id: "f5", line: 2 });
      const delivered = [queue.deliver(five), queue.deliver(two)];
      world.github.gate = null;
      release();
      await queue.drain();
      return delivered;
    `);
    expect(result.outcomes).toEqual(["queued", "joined"]);
    const markers = result.reviews.flatMap(
      (review) => review.body.match(/:finding:f\d+ -->/g) ?? [],
    );
    expect(markers.sort()).toEqual([
      ":finding:f0 -->",
      ":finding:f2 -->",
      ":finding:f5 -->",
    ]);
  });

  it("counts each finding id once, and values the poster refuses not at all", async () => {
    const result = await publish(`
      world.chat.turn = { id: "t1", status: "running" };
      world.find("t1", { id: "f1", line: 2 });
      // A resubmission, and a value a schema change would let through.
      world.find("t1", { id: "f1", line: 2, title: "Again" });
      world.find("t1", { id: "bad", line: 2, severity: "nit" });
      for (let index = 2; index <= 31; index += 1)
        world.find("t1", { id: "f" + index, line: 2 });
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.chat.turn = null;
      return runWorkflow(postReviews, event("t1"), world.context);
    `);
    const markers = result.reviews.flatMap(
      (review) => review.body.match(/:finding:[a-z]+\d* -->/g) ?? [],
    );
    // The first 30 distinct ids, each once: the resubmission took no place.
    expect(new Set(markers).size).toBe(30);
    expect(markers).toHaveLength(30);
    expect(markers).toContain(":finding:f30 -->");
    expect(markers).not.toContain(":finding:bad -->");
    expect(markers).not.toContain(":finding:f31 -->");
    expect(result.reviews[0]?.body).toContain("1 more finding was not posted");
  });

  it("shows nothing for a turn no longer queued or at work, and lets a turn still queued speak for the head", async () => {
    const result = await publish(`
      // t1's queued event arrives after it was cancelled.
      const late = await runWorkflow(postReviews, lateEvent("t1", "queued"), world.context);
      // t2 shows it waits; t3 queues behind it, then t2 is cancelled.
      await runWorkflow(postReviews, event("t2", "queued"), world.context);
      await runWorkflow(postReviews, event("t3", "queued"), world.context);
      await runWorkflow(postReviews, event("t2", "cancelled"), world.context);
      return late;
    `);
    expect(result.outcomes).toMatchObject({ posted: "nothing" });
    // One run, still waiting for t3: nothing ended it as not reviewed.
    expect(result.runs).toEqual([
      {
        commit: "a",
        status: "in_progress",
        conclusion: null,
        title: "Waiting to start",
      },
    ]);
  });

  it("posts findings that arrive one by one in batches, at most 30 a turn, each once", async () => {
    const result = await publish(`
      world.chat.turn = { id: "t1", status: "running" };
      const queue = workflowQueue(postReviews, world.context);
      for (let index = 0; index < 45; index += 1) {
        queue.deliver(world.find("t1", { id: "f" + index, line: 2 }));
        // Some arrive while a publication runs, some between them.
        if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      world.chat.turn = null;
      queue.deliver(event("t1"));
      const { outcomes, refused } = await queue.drain();
      return { runs: outcomes.length, refused: refused.length };
    `);
    const markers = result.reviews.flatMap(
      (review) => review.body.match(/:finding:f\d+ -->/g) ?? [],
    );
    // The turn's first 30, each posted once, on their own or with the
    // review; none past them.
    expect(new Set(markers).size).toBe(30);
    expect(markers).toHaveLength(30);
    expect(markers).toContain(":finding:f0 -->");
    expect(markers).toContain(":finding:f29 -->");
    expect(markers).not.toContain(":finding:f30 -->");
    const outcome = result.outcomes as { runs: number; refused: number };
    expect(outcome.refused).toBe(0);
    // Fewer publications than findings, and a few GitHub calls each.
    expect(outcome.runs).toBeLessThan(30);
    expect(result.calls).toBeLessThanOrEqual(4 * outcome.runs + 6);
  });

  it("holds a commit to 30 findings posted on their own, across its turns", async () => {
    const result = await publish(`
      for (const turn of ["t1", "t2"]) {
        world.chat.turn = { id: turn, status: "running" };
        for (let index = 0; index < 20; index += 1)
          await runWorkflow(postReviews, world.find(turn, { id: turn + "-f" + index, line: 2 }), world.context);
      }
      return null;
    `);
    const markers = result.reviews.flatMap(
      (review) => review.body.match(/:finding:t\d-f\d+ -->/g) ?? [],
    );
    expect(markers).toHaveLength(30);
    expect(markers.filter((entry) => entry.includes("t2-"))).toHaveLength(10);
  });

  it("shows progress again on a head an earlier run sits on cancelled, the same turn's included", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t1", "queued"), world.context);
      // A push supersedes the head, then the author pushes it back, and the
      // same turn t1 runs on it after all.
      world.github.head = ${JSON.stringify(OTHER)};
      await runWorkflow(postReviews, event("t2", "queued"), world.context);
      world.github.head = ${JSON.stringify(HEAD)};
      world.chat.turn = { id: "t1", status: "running" };
      await runWorkflow(postReviews, event("t1", "running"), world.context);
      return world.github.checks.map((run) => run.externalId);
    `);
    expect(result.runs.map((run) => [run.commit, run.status])).toEqual([
      ["a", "completed"],
      ["d", "completed"],
      ["a", "in_progress"],
    ]);
    // Each run is stamped by the event that made it, never taken up again.
    expect(result.outcomes).toEqual([
      "work-review:42:progress:event-1",
      "work-review:42:progress:event-2",
      "work-review:42:progress:event-3",
    ]);
  });

  it("ends the check of a queued turn cancelled with nothing else to review the head", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t1", "queued"), world.context);
      // A newer turn at work keeps it: that turn reviews the head.
      world.chat.turn = { id: "t2", status: "running" };
      await runWorkflow(postReviews, event("t1", "cancelled"), world.context);
      const kept = world.github.checks[0].status;
      world.chat.turn = null;
      await runWorkflow(postReviews, event("t3", "cancelled"), world.context);
      return kept;
    `);
    expect(result.outcomes).toBe("in_progress");
    expect(result.runs).toEqual([
      {
        commit: "a",
        status: "completed",
        conclusion: "cancelled",
        title: "Not reviewed",
      },
    ]);
  });

  it("always ends this pull request's own run, where another pull request on the head holds a stronger verdict", async () => {
    const result = await publish(`
      await runWorkflow(postReviews, event("t1", "queued"), world.context);
      // Another pull request with the same head already failed it.
      world.github.checks.push({ id: 7, own: true, status: "completed", conclusion: "failure", externalId: "work-review:other:check", headSha: ${JSON.stringify(HEAD)}, title: "Changes requested (score 1/5)" });
      world.submit("t1", { verdict: "COMMENT", reviewedCommit: ${JSON.stringify(HEAD)} });
      return runWorkflow(postReviews, event("t1"), world.context);
    `);
    expect(result.runs[0]).toEqual({
      commit: "a",
      status: "completed",
      conclusion: "failure",
      title: "Changes requested",
    });
    expect(result.outcomes).toMatchObject({ verdict: "failure" });
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

describe("report text", () => {
  const head = "a".repeat(40);
  // Each pass of a single replace leaves what the one inside it formed.
  const planted = [
    `<!<!---- work-review:${head}:review ---->>`,
    "<<!--!---->-- hidden -->",
    "<!-<!---->- x --<!---->>",
  ];

  it("opens no HTML comment, declaration or processing instruction, however nested, and hides no word", () => {
    const hiding = [
      ...planted,
      "<!DOCTYPE hidden words>",
      "<![CDATA[ hidden words ]]>",
      "<?php hidden words ?>",
      "<?xml hidden words?>",
      "<!<!X hidden>>",
    ];
    for (const text of hiding) {
      const shown = publicationText(text);
      // Nothing GitHub drops can open: no "<!" or "<?" is left.
      expect(shown, text).not.toMatch(/<[!?]/);
      // Nothing is removed: without the zero-width spaces it is the text.
      expect(shown.replaceAll("\u200b", ""), text).toBe(text);
    }
    // Code spans read as written.
    const code = "Use `<!-- keep -->` and `<?= $x ?>` in templates.";
    expect(publicationText(code).replaceAll("\u200b", "")).toBe(code);
    expect(publicationText("@<!---->team, ask @grace")).toBe(
      "@<\u200b!---->team, ask @\u200bgrace",
    );
    expect(publicationText("a < b && c --> d")).toBe("a < b && c --> d");
  });

  it("defuses every field of a review that reaches a GitHub body", () => {
    for (const text of planted) {
      const checked = checkWorkReview({
        reviewedCommit: head,
        verdict: "COMMENT",
        score: 3,
        summary: `Fine. ${text}`,
        checkSummary: text,
        reply: { inReplyTo: 7, body: text },
      });
      expect(typeof checked).toBe("object");
      expect(JSON.stringify(checked), text).not.toMatch(/<[!?]/);
      // A finding's words reach its inline comment and, outside the diff,
      // the review's body.
      const finding = checkFinding({
        id: "f1",
        path: `src/${text}.ts`,
        line: 2,
        severity: "minor",
        title: text,
        body: text,
      });
      if (typeof finding === "string") throw new Error(finding);
      // The comment's own marker is the poster's, at its end.
      for (const posted of [
        findingComment(finding, head).body.replace(
          findingMarker(head, "f1"),
          "",
        ),
        findingLine(finding),
      ])
        expect(posted, text).not.toMatch(/<[!?]/);
    }
  });
});
