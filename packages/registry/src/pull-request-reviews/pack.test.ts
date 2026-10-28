// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SESSION_PULL_REQUESTS_CONTRACT } from "@catamorphic/agent-protocol";
import {
  agentDefinitionSchema,
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

describe("the pull-request-reviews pack", () => {
  it("installs the automation and a project skill that explains it", () => {
    expect(Object.keys(PACK.files)).toEqual([
      ".work/project.json",
      ".work/images/review.Dockerfile",
      ".work/triggers/github.ts",
      ".work/agents/reviewer.json",
      ".work/agents/reviewer.md",
      ".work/workflows/src/reviews.ts",
      ".work/server/review-report.ts",
      ".work/server/review-publisher.ts",
      ".work/server/review-publisher.sql",
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
      /^FROM docker:[\w.-]+-dind$/m,
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
    expect(REVIEW_OPENCODE_DOCKERFILE).toMatch(/^FROM docker:[\w.-]+-dind$/m);
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

describe("postReviews", () => {
  it("returns one durable publisher transition with ids only", async () => {
    const result = await run({
      script: `
      const input = ${JSON.stringify(turnEvent({ key: "pr-acme/web-42" }))};
      const publisherHost = { "company.review-publication": { publish: args => ({ operation: "publish", args }) } };
      console.log(JSON.stringify(await postReviews.steps[0].run({ input, host: publisherHost })));
    `,
    });
    expect(result).toEqual({
      operation: "publish",
      args: { sessionId: "session-1", turnId: "t1" },
    });
  });
});
