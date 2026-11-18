// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseProjectEnvironmentPolicy } from "@catamorphic/core";
import {
  matchesAllWhere,
  parseProject,
  resolveTriggerBinding,
} from "@catamorphic/parser";
import { expect, it } from "vitest";
import { packFiles } from "../pack-files.js";

const PACK = packFiles("github-polling");
const REVIEWS = packFiles("pull-request-reviews");
const library = PACK.files[".work/triggers/github.ts"];
const poller = PACK.files[".work/workflows/src/github-polling.ts"];

/** A repository at one moment: what GitHub's REST lists return. */
interface World {
  pulls: object[];
  issueComments: object[];
  reviewComments: object[];
}

interface Poll {
  world: World;
  /** Another poll writes the cursor after this one read it. */
  overlapped?: boolean;
}

interface PollResult {
  error?: string;
  output?: unknown;
  recorded: { kind: string; id: string; payload: Record<string, unknown> }[];
  requests: { path: string; query: Record<string, string> }[];
  writes: number[];
}

/**
 * Runs the shipped poller under bun, step by step like the host: each
 * returned call is executed by a fake (documents in a store, `get` on a
 * fake GitHub, `record` into an event table that keeps one event per id),
 * and its result, with any carried state, is the next step's input.
 * Timestamps written `T+60` are seconds from the start of the script.
 */
async function polls(sequence: Poll[]): Promise<PollResult[]> {
  if (!poller) throw new Error("Missing poller");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "github-poll-"));
  try {
    const workflowModule = path.resolve(
      import.meta.dirname,
      "../../../workflow/src/index.ts",
    );
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      poller.replace('"@catamorphic/workflow"', JSON.stringify(workflowModule)),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { pollGithub } from "./recipe.ts";
      const start = Date.now();
      const time = (value) => JSON.parse(JSON.stringify(value), (_key, item) =>
        typeof item === "string" && /^T[+-]\\d+$/.test(item)
          ? new Date(start + Number(item.slice(1)) * 1000).toISOString()
          : item);
      const sequence = time(${JSON.stringify(sequence)});
      const store = new Map();
      const events = new Map();
      const call = (name) => (args, options) => ({ call: name, args, options });
      const documents = Object.fromEntries(["list", "read", "write"].map((fn) => [fn, call("documents." + fn)]));
      const connections = { github: { get: call("github.get") } };
      const host = { "catamorphic.events": { record: call("events.record") } };
      const results = [];
      for (const poll of sequence) {
        const result = { recorded: [], requests: [], writes: [] };
        const page = (items, query, compare) => {
          const size = Number(query.per_page);
          const from = (Number(query.page ?? 1) - 1) * size;
          return { status: 200, body: items.slice().sort(compare).slice(from, from + size), totalBytes: 1 };
        };
        const execute = ({ call, args }) => {
          // As Work lists: a prefix is a folder, and lists what is under it.
          if (call === "documents.list")
            return [...store.entries()].filter(([path]) => path.startsWith(args.prefix.endsWith("/") ? args.prefix : args.prefix + "/")).map(([path, doc]) => ({ path, source: "store", contentType: "application/json", size: doc.text.length, version: doc.version }));
          if (call === "documents.read") {
            const doc = store.get(args.path);
            if (poll.overlapped) store.set(args.path, { ...doc, version: doc.version + 1 });
            return { path: args.path, source: "store", version: doc.version, text: doc.text };
          }
          if (call === "documents.write") {
            const current = store.get(args.path)?.version ?? 0;
            if (args.ifVersion !== current) throw new Error("version conflict: the document is at " + current);
            result.writes.push(args.ifVersion);
            store.set(args.path, { text: args.text, version: current + 1 });
            return { path: args.path, source: "store", version: current + 1 };
          }
          if (call === "github.get") {
            result.requests.push({ path: args.path, query: args.query });
            const since = (item) => item.updated_at >= args.query.since;
            const asc = (a, b) => a.updated_at.localeCompare(b.updated_at);
            if (args.path.endsWith("/issues/comments")) return page(poll.world.issueComments.filter(since), args.query, asc);
            if (args.path.endsWith("/pulls/comments")) return page(poll.world.reviewComments.filter(since), args.query, asc);
            return page(poll.world.pulls, args.query, (a, b) => b.updated_at.localeCompare(a.updated_at));
          }
          if (call === "events.record")
            return { events: args.events.map((event) => {
              const key = event.kind + ":" + event.id;
              const created = !events.has(key);
              if (created) { events.set(key, event); result.recorded.push(event); }
              return { kind: event.kind, id: event.id, eventId: key, created, occurredAt: event.occurredAt, receivedAt: event.occurredAt };
            }) };
          throw new Error("unexpected call " + call);
        };
        try {
          let input = { activationId: "a", scheduledFor: "T+0", firedAt: "T+0" };
          for (const step of pollGithub.steps) {
            const returned = await step.run({ input, documents, connections, host });
            if (returned && typeof returned === "object" && "call" in returned) {
              const value = execute(returned);
              input = returned.options ? { result: value, state: returned.options.state } : value;
            } else input = returned;
          }
          result.output = input;
        } catch (error) {
          result.error = String(error.message ?? error);
        }
        results.push(result);
      }
      console.log(JSON.stringify(results));
    `,
    );
    const result = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 20000,
    });
    return JSON.parse(result.stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const user = (login: string, type = "User") => ({ login, type });

function pull(input: {
  number: number;
  head: string;
  created: string;
  updated: string;
  state?: "open" | "closed";
  draft?: boolean;
  closed?: string;
  merged?: string;
}) {
  return {
    number: input.number,
    state: input.state ?? "open",
    title: `Change ${input.number}`,
    body: null,
    html_url: `https://github.com/acme/web/pull/${input.number}`,
    draft: input.draft ?? false,
    user: user("ada"),
    requested_reviewers: [],
    head: { sha: input.head, ref: `feature-${input.number}` },
    base: { sha: "base", ref: "main" },
    created_at: input.created,
    updated_at: input.updated,
    closed_at: input.closed ?? null,
    merged_at: input.merged ?? null,
  };
}

const issueComment = (input: {
  id: number;
  number: number;
  at: string;
  author?: { login: string; type: string };
}) => ({
  id: input.id,
  body: "@work why?",
  html_url: `https://github.com/acme/web/pull/${input.number}#issuecomment-${input.id}`,
  issue_url: `https://api.github.com/repos/acme/web/issues/${input.number}`,
  user: input.author ?? user("grace"),
  created_at: input.at,
  updated_at: input.at,
});

const reviewComment = (input: { id: number; number: number; at: string }) => ({
  id: input.id,
  body: "@work is this safe?",
  html_url: `https://github.com/acme/web/pull/${input.number}#discussion_r${input.id}`,
  pull_request_url: `https://api.github.com/repos/acme/web/pulls/${input.number}`,
  path: "src/index.ts",
  line: 12,
  user: user("grace"),
  created_at: input.at,
  updated_at: input.at,
});

it("installs the poller, the GitHub library the reviews use, and a project skill", () => {
  expect(Object.keys(PACK.files)).toEqual([
    ".work/project.json",
    ".work/triggers/github.ts",
    ".work/workflows/src/github-polling.ts",
    ".work/skills/github-polling/SKILL.md",
  ]);
  // The same library as the review pack, so either may install it.
  expect(library).toBe(REVIEWS.files[".work/triggers/github.ts"]);
  expect(PACK.files[".work/skills/github-polling/SKILL.md"]).toMatch(
    /^---\nname: github-polling\n/,
  );
  const policy = parseProjectEnvironmentPolicy(
    JSON.parse(PACK.files[".work/project.json"] ?? ""),
  );
  expect(policy.invalid).toBeUndefined();
  expect(policy.environments["github-poller"]).toMatchObject({
    workloads: ["workflow"],
    connections: { github: { capabilities: ["get"] } },
  });
  if (!library || !poller) throw new Error("Missing sources");
  const parsed = parseProject({
    ".work/triggers/github.ts": library,
    ".work/workflows/src/github-polling.ts": poller,
  });
  expect(parsed.errors).toEqual([]);
  const [workflow] = parsed.workflows;
  expect(workflow?.functionName).toBe("pollGithub");
  expect(workflow?.graph.permissions).toEqual(["events:write"]);
  expect(workflow?.graph.connections).toEqual([
    { alias: "github", principal: "service", capabilities: ["get"] },
  ]);
  expect(workflow?.graph.triggers).toMatchObject([
    { kind: "schedule", config: { cron: "* * * * *", timezone: "UTC" } },
  ]);
  // The library's webhook verifies senders; its kinds opt in to recording.
  for (const kind of [
    "github.pull_request",
    "github.issue_comment",
    "github.pull_request_review_comment",
  ])
    expect(
      resolveTriggerBinding({
        binding: { kind, config: {} },
        projectKinds: parsed.triggerKinds,
      }),
    ).toMatchObject({ ok: true, binding: { recordable: true } });
});

it("records a baseline first, then a new pull request, a push, comments by people, and a close, advancing its cursor by version", async () => {
  const old = pull({
    number: 1,
    head: "a1",
    created: "T-7200",
    updated: "T-3600",
  });
  const opened = pull({
    number: 2,
    head: "b1",
    created: "T+10",
    updated: "T+10",
  });
  const pushed = {
    ...old,
    head: { ...old.head, sha: "a2" },
    updated_at: "T+20",
  };
  const commented = { ...opened, updated_at: "T+30" };
  const comments = [
    issueComment({ id: 100, number: 1, at: "T-3000" }),
    issueComment({ id: 101, number: 2, at: "T+30" }),
    issueComment({
      id: 102,
      number: 2,
      at: "T+31",
      author: user("work-app[bot]", "Bot"),
    }),
    // GitHub's GraphQL login for an App has no [bot]: the type decides.
    issueComment({
      id: 103,
      number: 2,
      at: "T+32",
      author: user("work-app", "Bot"),
    }),
  ];
  const review = reviewComment({ id: 200, number: 1, at: "T+33" });
  const closed = {
    ...commented,
    state: "closed" as const,
    closed_at: "T+40",
    merged_at: "T+40",
    updated_at: "T+40",
  };
  const results = await polls([
    // The first poll sees an existing pull request and comment: nothing.
    {
      world: {
        pulls: [old],
        issueComments: [comments[0] ?? {}],
        reviewComments: [],
      },
    },
    { world: { pulls: [opened, old], issueComments: [], reviewComments: [] } },
    {
      world: { pulls: [pushed, opened], issueComments: [], reviewComments: [] },
    },
    {
      world: {
        pulls: [commented, pushed],
        issueComments: comments,
        reviewComments: [review],
      },
    },
    {
      world: {
        pulls: [closed, pushed],
        issueComments: comments,
        reviewComments: [review],
      },
    },
    // Nothing changed: nothing new, and the cursor still advances.
    {
      world: {
        pulls: [closed, pushed],
        issueComments: comments,
        reviewComments: [review],
      },
    },
  ]);
  expect(results.map((result) => result.error)).toEqual(
    results.map(() => undefined),
  );
  expect(
    results.map((result) => result.recorded.map((event) => event.id)),
  ).toEqual([
    [],
    ["pull_request:2:opened"],
    ["pull_request:1:synchronize:a2"],
    ["issue_comment:101", "pull_request_review_comment:200"],
    [expect.stringMatching(/^pull_request:2:closed:/)],
    [],
  ]);
  // Each poll writes the cursor at the version it read.
  expect(results.map((result) => result.writes)).toEqual([
    [0],
    [1],
    [2],
    [3],
    [4],
    [5],
  ]);
  expect(results[5]?.output).toEqual({ recorded: 0, cursorVersion: 6 });
  // Comments are read from the cursor, oldest change first.
  expect(results[3]?.requests).toEqual([
    {
      path: "/repos/acme/web/pulls",
      query: {
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: "20",
        page: "1",
      },
    },
    {
      path: "/repos/acme/web/issues/comments",
      query: expect.objectContaining({ sort: "updated", direction: "asc" }),
    },
    {
      path: "/repos/acme/web/pulls/comments",
      query: expect.objectContaining({ sort: "updated", direction: "asc" }),
    },
  ]);

  const [push] = results[2]?.recorded ?? [];
  expect(push?.payload).toMatchObject({
    name: "github",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "pull_request:1:synchronize:a2",
    },
    body: {
      action: "synchronize",
      number: 1,
      before: "a1",
      after: "a2",
      pull_request: { head: { sha: "a2" }, merged: false, draft: false },
      repository: { full_name: "acme/web" },
    },
  });
  const [close] = results[4]?.recorded ?? [];
  expect(close?.payload).toMatchObject({
    body: { action: "closed", pull_request: { merged: true } },
  });

  // Every event starts exactly the review workflows its webhook delivery
  // would: the reviews pack's own triggers, filters and all.
  if (!library) throw new Error("Missing library");
  const reviews = parseProject({
    ".work/triggers/github.ts": library,
    ".work/workflows/src/reviews.ts":
      REVIEWS.files[".work/workflows/src/reviews.ts"] ?? "",
  });
  expect(reviews.errors).toEqual([]);
  const started = (event: { payload: Record<string, unknown> }) =>
    reviews.workflows.flatMap((workflow) =>
      workflow.graph.triggers.flatMap((binding) => {
        const resolved = resolveTriggerBinding({
          binding,
          projectKinds: reviews.triggerKinds,
        });
        if (!resolved.ok || resolved.binding.kind !== "webhook") return [];
        const delivered = {
          payload: { ...event.payload, origin: { type: "workflow" } },
        };
        return matchesAllWhere(resolved.binding.where, delivered)
          ? [workflow.functionName]
          : [];
      }),
    );
  expect(
    results.flatMap((result) =>
      result.recorded.map((event) => [event.id, started(event)]),
    ),
  ).toEqual([
    ["pull_request:2:opened", ["reviewPullRequests"]],
    ["pull_request:1:synchronize:a2", ["reviewPullRequests"]],
    ["issue_comment:101", ["answerReviewComments"]],
    ["pull_request_review_comment:200", ["answerReviewComments"]],
    [
      expect.stringMatching(/^pull_request:2:closed:/),
      ["closePullRequestChats"],
    ],
  ]);
});

it("an overlapping poll leaves the cursor alone, and the next records nothing twice", async () => {
  const opened = pull({
    number: 3,
    head: "c1",
    created: "T+10",
    updated: "T+10",
  });
  const world = { pulls: [opened], issueComments: [], reviewComments: [] };
  const results = await polls([
    { world: { pulls: [], issueComments: [], reviewComments: [] } },
    { world, overlapped: true },
    { world },
  ]);
  expect(results[1]?.error).toContain("version conflict");
  expect(results[1]?.recorded.map((event) => event.id)).toEqual([
    "pull_request:3:opened",
  ]);
  // The cursor did not move, so the next poll finds it again; its id is
  // already recorded.
  expect(results[2]?.error).toBeUndefined();
  expect(results[2]?.recorded).toEqual([]);
});

it("records a pull request's opening and reopening once though a lost cursor write replays them after it changed", async () => {
  const opened = pull({
    number: 3,
    head: "c1",
    created: "T+10",
    updated: "T+10",
  });
  const pushed = {
    ...opened,
    head: { ...opened.head, sha: "c2" },
    updated_at: "T+20",
  };
  const closed = pull({
    number: 4,
    head: "d1",
    created: "T-7200",
    updated: "T-100",
    state: "closed",
    closed: "T-100",
  });
  const reopened = {
    ...closed,
    state: "open" as const,
    closed_at: null,
    updated_at: "T+10",
  };
  const touched = { ...reopened, updated_at: "T+20" };
  const results = await polls([
    { world: { pulls: [closed], issueComments: [], reviewComments: [] } },
    // Records, then loses its cursor write.
    {
      world: {
        pulls: [opened, reopened],
        issueComments: [],
        reviewComments: [],
      },
      overlapped: true,
    },
    // Both changed again before the next poll read them.
    {
      world: {
        pulls: [pushed, touched],
        issueComments: [],
        reviewComments: [],
      },
    },
  ]);
  expect(results[1]?.error).toContain("version conflict");
  expect(
    results.map((result) => result.recorded.map((event) => event.id)),
  ).toEqual([
    [],
    [
      expect.stringMatching(/^pull_request:4:reopened:/),
      "pull_request:3:opened",
    ],
    [],
  ]);
});

it("keeps comments on pull requests a catch-up sweep has not reached yet", async () => {
  // A comment on #10, then 24 other pull requests change: #10 is on page 2.
  const late = pull({ number: 10, head: "l1", created: "T+5", updated: "T+6" });
  const others = Array.from({ length: 24 }, (_, index) =>
    pull({
      number: 20 + index,
      head: `o${index}`,
      created: `T+${10 + index}`,
      updated: `T+${10 + index}`,
    }),
  );
  const world = {
    pulls: [late, ...others],
    issueComments: [
      issueComment({ id: 501, number: 10, at: "T+6" }),
      // On a pull request the first page reaches.
      issueComment({ id: 500, number: 30, at: "T+20" }),
    ],
    reviewComments: [],
  };
  const results = await polls([
    { world: { pulls: [], issueComments: [], reviewComments: [] } },
    { world },
    { world },
    { world },
  ]);
  expect(
    results.map((result) =>
      result.recorded
        .filter((event) => event.kind === "github.issue_comment")
        .map((event) => event.id),
    ),
  ).toEqual([[], ["issue_comment:500"], ["issue_comment:501"], []]);
});

it("sweeps older pages while a whole page is newer than the cursor", async () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    pull({
      number: 10 + index,
      head: `h${index}`,
      created: `T+${10 + index}`,
      updated: `T+${10 + index}`,
    }),
  );
  const world = { pulls: many, issueComments: [], reviewComments: [] };
  const results = await polls([
    { world: { pulls: [], issueComments: [], reviewComments: [] } },
    { world },
    { world },
    { world },
  ]);
  expect(results.map((result) => result.recorded.length)).toEqual([
    0, 20, 5, 0,
  ]);
  expect(results.map((result) => result.requests[0]?.query.page)).toEqual([
    "1",
    "1",
    "2",
    "1",
  ]);
});
