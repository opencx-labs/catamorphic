import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { matchesAllWhere, parseProject } from "@catamorphic/parser";
import { describe, expect, it } from "vitest";
import { REVIEW_AUTOMATION_FILES } from "../reviewing-pull-requests-skill.js";
import { HOST_SKILLS } from "../seeds.js";
import { agentDefinitionSchema } from "../services/agent-definitions-service.js";
import { parseProjectEnvironmentPolicy } from "../services/project-environments-service.js";

const SKILL = HOST_SKILLS["reviewing-pull-requests/SKILL.md"] ?? "";
const file = (name: string) => {
  const content = REVIEW_AUTOMATION_FILES[name];
  if (content === undefined) throw new Error(`Missing ${name}`);
  return content;
};

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
      path.join(directory, "verify.ts"),
      `
      import { answerReviewComments, closePullRequestChats, postReviews, reviewPullRequests } from "./recipe.ts";
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

describe("the reviewing-pull-requests skill", () => {
  it("shows every file of the automation verbatim", () => {
    for (const [name, content] of Object.entries(REVIEW_AUTOMATION_FILES)) {
      expect(SKILL, name).toContain(`## ${name}`);
      expect(SKILL, name).toContain(content);
    }
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
      network: { egress: "allowlist" },
      approvals: { waitMinutes: 60 },
    });
    expect(Object.keys(review?.connections ?? {})).toEqual([
      "github",
      "prod",
      "slack",
    ]);
    expect(review?.connections?.github).toMatchObject({
      principal: "service",
      git: { push: ["work/*"] },
    });
    // The review chat runs beside the pull request's code: it only reads
    // GitHub (ADR 0259). The poster's Environment runs no agent and holds
    // typed writes, never a raw REST write verb.
    const rawWrites = ["post", "put", "patch", "delete"];
    const reads = ["get", "pull_request_files", "review_threads"];
    expect(review?.connections?.github?.capabilities).toEqual([
      ...reads,
      "git:read",
      "git:write",
    ]);
    const poster = policy.environments["github-poster"];
    expect(poster).toMatchObject({ workloads: ["workflow"] });
    expect(Object.keys(poster?.connections ?? {})).toEqual(["github"]);
    const posterCapabilities = poster?.connections?.github?.capabilities ?? [];
    expect(posterCapabilities).toContain("create_review");
    for (const verb of [...rawWrites, "git:write"])
      expect(posterCapabilities).not.toContain(verb);
    expect(REVIEW_AUTOMATION_FILES[".work/images/review.Dockerfile"]).toMatch(
      /^FROM docker:[\w.-]+-dind$/m,
    );
    const agent = agentDefinitionSchema().safeParse(
      JSON.parse(file(".work/agents/reviewer.json")),
    );
    expect(agent.success, JSON.stringify(agent.error)).toBe(true);
    expect(agent.data).toMatchObject({
      sandboxing: "propose",
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

  it("parses as four workflows on the GitHub library and session events", () => {
    const parsed = parseProject({
      ".work/triggers/github.ts": file(".work/triggers/github.ts"),
      ".work/workflows/src/reviews.ts": file(".work/workflows/src/reviews.ts"),
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
      statuses: ["completed", "failed"],
    });

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
      "Answer in your work-review block's reply with inReplyTo 7.",
    );
    expect(inline.endsWith("@work why a loop?")).toBe(true);
    const mention = (result as { mention: { args: { content: string } } })
      .mention.args.content;
    expect(mention).toContain("Answer in your work-review block's reply. ");
  });
});

/** The reviewer's reply: prose, then its one work-review block. */
const reply = (report: unknown, blocks = 1) =>
  [
    "Reviewed the totals change.",
    ...Array.from(
      { length: blocks },
      () => `\`\`\`work-review\n${JSON.stringify(report)}\n\`\`\``,
    ),
  ].join("\n\n");

const STAMP = "<!-- work-review turn=t1 -->";
const REQUESTED = {
  reviewedCommit: HEAD,
  verdict: "REQUEST_CHANGES",
  score: 2,
  summary: "One blocking issue: a null total.",
  checkSummary: "Ran bun test (12 passed).",
  comments: [
    { path: "src/orders.ts", line: 11, body: "This total can be null." },
    { path: "src/orders.ts", line: 40, body: "Not in the diff." },
  ],
  resolve: [
    { threadId: "PRRT_own", reply: "Fixed in this push." },
    { threadId: "PRRT_human" },
  ],
  reply: { inReplyTo: 22, body: "Because totals are cents." },
};

interface PosterScenario {
  event?: unknown;
  content?: string;
  workspace?: { ref: string; commit: string } | null;
  reviews?: unknown[];
  checkRuns?: unknown;
  threads?: unknown[];
  conversation?: unknown[];
  description?: string;
}

/**
 * Runs every step of postReviews in order, as the host would: each
 * returned call is answered by a fake GitHub or session host, with its
 * state carried beside the result (ADR 0260).
 */
async function post(scenario: PosterScenario): Promise<{
  writes: Array<[string, Record<string, unknown>]>;
  error?: string;
}> {
  const full = {
    event: turnEvent({ key: "pr-acme/web-42" }),
    content: reply(REQUESTED),
    workspace: { ref: "refs/pull/42/head", commit: HEAD },
    reviews: [
      { id: 3, state: "CHANGES_REQUESTED", own: true, body: "Earlier." },
      { id: 4, state: "CHANGES_REQUESTED", own: false, body: "A person's." },
      { id: 5, state: "COMMENTED", own: true, body: "A comment." },
    ],
    checkRuns: { status: 200, body: { total_count: 0, check_runs: [] } },
    threads: [
      {
        id: "PRRT_own",
        isResolved: false,
        comments: [
          { id: 21, own: true, body: "Totals overflow." },
          { id: 22, own: false, body: "@work why cents?" },
        ],
      },
      {
        id: "PRRT_human",
        isResolved: false,
        comments: [{ id: 31, own: false, body: "Rename this." }],
      },
    ],
    conversation: [],
    description: "Adds order totals.",
    ...scenario,
  };
  return (await run({
    script: `
      const scenario = ${JSON.stringify(full)};
      const writes = [];
      const write = (action, result) => (args) => { writes.push([action, args]); return result; };
      const github = {
        pull_request_files: () => ({ files: [{ path: "src/orders.ts", patch: "@@ -10,2 +10,3 @@\\n line10\\n+added11\\n line12" }] }),
        list_reviews: () => ({ reviews: scenario.reviews }),
        review_threads: () => ({ threads: scenario.threads }),
        get: ({ path }) =>
          path.endsWith("/check-runs") ? scenario.checkRuns
          : path.endsWith("/comments") ? { status: 200, body: scenario.conversation }
          : { status: 200, body: { number: 42, body: scenario.description } },
        create_review: write("create_review", { id: 900 }),
        create_check_run: write("create_check_run", { id: 5 }),
        dismiss_review: write("dismiss_review", { reviews: [] }),
        resolve_review_thread: write("resolve_review_thread", { threads: [] }),
        reply_to_review_comment: write("reply_to_review_comment", { id: 99 }),
        issue_comment: write("issue_comment", { id: 98 }),
        update_pull_request: write("update_pull_request", { number: 42 }),
      };
      const sessions = {
        history: ({ sessionId, through }) => ({
          sessionId,
          key: "pr-acme/web-42",
          messages: [{ id: through ?? "input-1", role: through ? "assistant" : "user", content: scenario.content, createdAt: "2026-10-18T10:00:00Z" }],
        }),
        inspect: () => ({ id: "session-1", key: "pr-acme/web-42", workspace: scenario.workspace }),
      };
      const calls = (target) => new Proxy({}, { get: (_t, name) => (args, options) => ({ target, name, args, options }) });
      const connections = new Proxy({}, { get: () => calls("github") });
      const hostCalls = { "catamorphic.sessions": calls("sessions") };
      let input = scenario.event;
      try {
        for (const step of postReviews.steps) {
          const out = await step.run({ input, host: hostCalls, connections });
          if (out && (out.target === "github" || out.target === "sessions")) {
            const fn = (out.target === "github" ? github : sessions)[out.name];
            if (!fn) throw new Error("Unexpected call " + out.target + "." + out.name);
            const result = fn(out.args);
            input = out.options ? { result, state: out.options.state } : result;
          } else input = out;
        }
        console.log(JSON.stringify({ writes }));
      } catch (error) {
        console.log(JSON.stringify({ writes, error: error.message }));
      }
    `,
  })) as { writes: Array<[string, Record<string, unknown>]>; error?: string };
}

describe("postReviews", () => {
  it("posts a review that requests changes: inline comments on the diff, its own threads, the answer, the summary", async () => {
    const { writes, error } = await post({});
    expect(error).toBeUndefined();
    expect(writes.map(([action]) => action)).toEqual([
      "create_review",
      "create_check_run",
      "resolve_review_thread",
      "reply_to_review_comment",
      "update_pull_request",
    ]);
    const [review, check, resolve, answer, description] = writes.map(
      ([, args]) => args,
    );
    // The repository and number come from the chat's key.
    expect(review).toMatchObject({
      repository: "acme/web",
      number: 42,
      event: "REQUEST_CHANGES",
      commitId: HEAD,
      comments: [
        {
          path: "src/orders.ts",
          line: 11,
          side: "RIGHT",
          body: "This total can be null.",
        },
      ],
    });
    // A comment off the diff moves into the body instead of failing it.
    expect(review?.body).toContain("`src/orders.ts:40`: Not in the diff.");
    expect(String(review?.body).endsWith(STAMP)).toBe(true);
    expect(check).toEqual({
      repository: "acme/web",
      name: "Work review",
      headSha: HEAD,
      externalId: "turn=t1",
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Changes requested (score 2/5)",
        summary: "Ran bun test (12 passed).",
      },
    });
    // Only the App's own thread; a person's thread stays open.
    expect(resolve).toEqual({
      repository: "acme/web",
      number: 42,
      threads: [
        { threadId: "PRRT_own", reply: `Fixed in this push.\n\n${STAMP}` },
      ],
    });
    expect(answer).toEqual({
      repository: "acme/web",
      number: 42,
      commentId: 22,
      body: `Because totals are cents.\n\n${STAMP}`,
    });
    expect(description).toEqual({
      repository: "acme/web",
      number: 42,
      body: [
        "Adds order totals.",
        "",
        "<!-- work-review:start -->",
        `**Work review** of ${HEAD.slice(0, 7)}: changes requested (score 2/5)`,
        "",
        "One blocking issue: a null total.",
        "<!-- work-review:end -->",
      ].join("\n"),
    });
  });

  it("dismisses its own earlier change requests once nothing blocks, and answers in the conversation", async () => {
    const { writes, error } = await post({
      content: reply({
        ...REQUESTED,
        verdict: "COMMENT",
        score: 5,
        summary: "Nothing blocks.",
        comments: [],
        resolve: [],
        reply: { body: "Yes, it is safe." },
      }),
      description:
        "Adds order totals.\n\n<!-- work-review:start -->\nold\n<!-- work-review:end -->\n\nTested by hand.",
    });
    expect(error).toBeUndefined();
    const byAction = Object.fromEntries(writes);
    expect(writes.map(([action]) => action)).toEqual([
      "create_review",
      "create_check_run",
      "dismiss_review",
      "issue_comment",
      "update_pull_request",
    ]);
    expect(byAction.create_review).toMatchObject({ event: "COMMENT" });
    expect(byAction.create_check_run).toMatchObject({ conclusion: "success" });
    // Its own change request only, never a person's.
    expect(byAction.dismiss_review).toMatchObject({ reviewIds: [3] });
    expect(byAction.issue_comment).toEqual({
      repository: "acme/web",
      number: 42,
      body: `Yes, it is safe.\n\n${STAMP}`,
    });
    // The summary is replaced in place; the author's text is kept.
    expect(String(byAction.update_pull_request?.body)).toBe(
      [
        "Adds order totals.",
        "",
        "<!-- work-review:start -->",
        `**Work review** of ${HEAD.slice(0, 7)}: nothing blocks (score 5/5)`,
        "",
        "Nothing blocks.",
        "<!-- work-review:end -->",
        "",
        "Tested by hand.",
      ].join("\n"),
    );
  });

  it("posts nothing twice when the same turn runs again", async () => {
    const first = await post({});
    const description = String(
      Object.fromEntries(first.writes).update_pull_request?.body,
    );
    const again = await post({
      reviews: [
        { id: 3, state: "CHANGES_REQUESTED", own: true, body: "Earlier." },
        {
          id: 900,
          state: "CHANGES_REQUESTED",
          own: true,
          body: `Posted.\n\n${STAMP}`,
        },
      ],
      checkRuns: {
        status: 200,
        body: { total_count: 1, check_runs: [{ external_id: "turn=t1" }] },
      },
      threads: [
        {
          id: "PRRT_own",
          isResolved: true,
          comments: [
            { id: 21, own: true, body: "Totals overflow." },
            { id: 22, own: false, body: "@work why cents?" },
            {
              id: 99,
              own: true,
              body: `Because totals are cents.\n\n${STAMP}`,
            },
          ],
        },
      ],
      description,
    });
    expect(again).toEqual({ writes: [] });
  });

  it("reports a neutral check run for a failed turn or a report it cannot use", async () => {
    const neutral = async (scenario: PosterScenario) => {
      const { writes, error } = await post(scenario);
      expect(error).toBeUndefined();
      expect(writes.map(([action]) => action)).toEqual(["create_check_run"]);
      const check = writes[0]?.[1];
      expect(check).toMatchObject({
        headSha: HEAD,
        conclusion: "neutral",
        output: { title: "No review" },
      });
      const output = check?.output;
      return typeof output === "object" &&
        output !== null &&
        "summary" in output
        ? String(output.summary)
        : "";
    };
    expect(
      await neutral({
        event: turnEvent({ key: "pr-acme/web-42", status: "failed" }),
      }),
    ).toBe("The review did not finish: its turn failed.");
    expect(
      await neutral({
        event: turnEvent({ key: "pr-acme/web-42", resultMessageId: null }),
      }),
    ).toBe("The review turn ended without a reply.");
    for (const [content, reason] of [
      [reply({ ...REQUESTED, verdict: "APPROVE" }), /verdict is neither/],
      [
        reply({ ...REQUESTED, repository: "acme/payments" }),
        /unknown field "repository"/,
      ],
      [reply(REQUESTED, 2), /more than one work-review block/],
      ["No block at all.", /no work-review block/],
      [reply({ ...REQUESTED, reviewedCommit: "abc" }), /not a full commit/],
      [
        reply({
          ...REQUESTED,
          comments: Array.from({ length: 31 }, () => REQUESTED.comments[0]),
        }),
        /comments is not a list of at most 30/,
      ],
      [
        reply({ ...REQUESTED, summary: "x".repeat(4001) }),
        /summary is missing or over/,
      ],
    ] as const)
      expect(await neutral({ content })).toMatch(reason);
  });

  it("posts nothing for a report on a commit the chat has moved past", async () => {
    expect(
      await post({
        workspace: { ref: "refs/pull/42/head", commit: "b".repeat(40) },
      }),
    ).toEqual({ writes: [] });
  });

  it("stops at a GitHub error a REST read reports as a status", async () => {
    const { writes, error } = await post({
      checkRuns: { status: 500, body: { message: "Server error" } },
    });
    expect(writes.map(([action]) => action)).toEqual(["create_review"]);
    expect(error).toBe("GitHub answered 500 reading the check runs");
  });
});
