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
      import { answerReviewComments, closePullRequestChats, reviewPullRequests } from "./recipe.ts";
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
      repository: { full_name: "acme/web" },
      sender: { login: "ada", type: "User" },
    },
  },
});

const comment = (input: { body: string; type?: string; inline?: boolean }) => ({
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
      repository: { full_name: "acme/web" },
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
    expect(REVIEW_AUTOMATION_FILES[".work/images/review.Dockerfile"]).toMatch(
      /^FROM docker:[\w.-]+-dind$/m,
    );
    const agent = agentDefinitionSchema().safeParse(
      JSON.parse(file(".work/agents/reviewer.json")),
    );
    expect(agent.success, JSON.stringify(agent.error)).toBe(true);
    expect(agent.data).toMatchObject({
      mode: "edit",
      environment: { preferred: ["review"], allowed: ["review"] },
    });
  });

  it("parses as three workflows on the GitHub library", () => {
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
    // The workflows hold no connection: the chat's Environment does.
    for (const workflow of parsed.workflows)
      expect(workflow.graph.connections).toEqual([]);

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
    expect(inline.endsWith("@work why a loop?")).toBe(true);
  });
});
