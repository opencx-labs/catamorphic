import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseProject } from "@catamorphic/parser";
import { expect, it } from "vitest";
import { HOST_SKILLS } from "../seeds.js";

const SKILL = HOST_SKILLS["slack/SKILL.md"] ?? "";
const blocks = [...SKILL.matchAll(/```typescript\n([\s\S]*?)```/g)].map(
  (match) => match[1] ?? "",
);
const library = blocks.find((source) =>
  source.startsWith("// .work/triggers/slack.ts"),
);
const recipes = blocks.find((source) =>
  source.includes("export const answerSlackMentions"),
);

/**
 * Runs the shipped recipes under bun with a fake host and connection
 * namespace that record the transitions each boundary returns.
 */
async function run(input: {
  script: string;
  members?: Record<string, string>;
}): Promise<unknown> {
  if (!recipes) throw new Error("Missing Slack recipes");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slack-recipe-"));
  try {
    const workflowModule = path.resolve(
      import.meta.dirname,
      "../../../workflow/src/index.ts",
    );
    const source = recipes
      .replace('"@catamorphic/workflow"', JSON.stringify(workflowModule))
      .replace(
        "const SLACK_MEMBERS: Record<string, string> = {};",
        `const SLACK_MEMBERS: Record<string, string> = ${JSON.stringify(input.members ?? {})};`,
      );
    await fs.writeFile(path.join(directory, "recipe.ts"), source);
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { answerSlackMentions, postSlackReplies } from "./recipe.ts";
      const host = { "catamorphic.sessions": Object.fromEntries(["deliver", "history"].map(operation => [operation, args => ({ operation, args })])) };
      const connection = path => new Proxy(function () {}, {
        get: (_target, name) => connection([...path, name]),
        apply: (_target, _self, [args]) => ({ alias: path[0], action: path.slice(1).join("."), args }),
      });
      const connections = connection([]);
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

const mention = (input: { ts: string; threadTs?: string; id: string }) => ({
  payload: {
    body: {
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event_id: input.id,
      event_time: 1,
      event: {
        type: "app_mention",
        user: "U1",
        text: "<@UAPP> summarize this thread",
        channel: "C1",
        ts: input.ts,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      },
    },
  },
});

it("the Slack library parses as three project kinds on one signed webhook", () => {
  if (!library || !recipes) throw new Error("Missing Slack skill sources");
  const parsed = parseProject({
    ".work/triggers/slack.ts": library,
    ".work/workflows/src/slack.ts": recipes,
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.triggerKinds.map((kind) => kind.name).sort()).toEqual([
    "slack.event",
    "slack.mention",
    "slack.message",
  ]);
  expect(parsed.secrets.map((secret) => secret.name)).toEqual([
    "SLACK_SIGNING_SECRET",
  ]);
  const workflows = Object.fromEntries(
    parsed.workflows.map((workflow) => [workflow.functionName, workflow]),
  );
  // The chat reads Slack; only the reply automation may post.
  expect(workflows.answerSlackMentions?.graph.connections).toEqual([
    {
      alias: "slack",
      principal: "service",
      capabilities: [
        "conversations.replies",
        "users.info",
        "chat.getPermalink",
      ],
    },
  ]);
  expect(workflows.postSlackReplies?.graph.connections).toEqual([
    { alias: "slack", principal: "service", capabilities: ["chat.postMessage"] },
  ]);
});

it("keeps one chat per Slack thread and one message per event", async () => {
  const events = [
    mention({ ts: "100.1", id: "Ev1" }),
    mention({ ts: "100.9", threadTs: "100.1", id: "Ev2" }),
  ];
  const calls = await run({
    script: `
      const events = ${JSON.stringify(events)};
      const calls = [];
      for (const event of events) calls.push(await answerSlackMentions.steps[0].run({ input: event, host }));
      console.log(JSON.stringify(calls));
    `,
  });
  const content = [
    "Slack user <@U1> mentioned you in Slack (channel C1, thread 100.1):",
    "<@UAPP> summarize this thread",
    "Read the thread with the slack connection's conversations.replies first. Answer here: your reply is posted to the thread.",
  ].join("\n\n");
  expect(calls).toEqual([
    {
      operation: "deliver",
      args: {
        key: "slack:C1:100.1",
        title: "Slack: <@UAPP> summarize this thread",
        content,
        idempotencyKey: "slack:Ev1",
      },
    },
    {
      operation: "deliver",
      args: {
        key: "slack:C1:100.1",
        title: "Slack: <@UAPP> summarize this thread",
        content,
        idempotencyKey: "slack:Ev2",
      },
    },
  ]);
});

it("names a Slack user as a member only where the project links them", async () => {
  const [call] = asArray(
    await run({
      members: { U1: "ada" },
      script: `
        console.log(JSON.stringify([await answerSlackMentions.steps[0].run({ input: ${JSON.stringify(mention({ ts: "7.1", id: "Ev7" }))}, host })]));
      `,
    }),
  );
  expect(call).toMatchObject({
    operation: "deliver",
    args: { key: "slack:C1:7.1" },
  });
  expect(JSON.stringify(call)).toContain(
    "Project member ada mentioned you in Slack",
  );
});

it("posts the settled reply to its thread and stays quiet for every other chat", async () => {
  const turn = (resultMessageId?: string) => ({
    payload: {
      sessionId: "chat-1",
      detail: {
        status: "completed",
        ...(resultMessageId ? { resultMessageId } : {}),
      },
    },
  });
  const settled = (key: string | null, role = "assistant") => ({
    sessionId: "chat-1",
    key,
    messages: [
      {
        id: "m-2",
        role,
        content: "The deploy is blocked on the migration.",
        createdAt: "2026-09-27T10:00:00Z",
      },
    ],
  });
  const result = await run({
    script: `
      const [read, post] = postSlackReplies.steps;
      console.log(JSON.stringify({
        read: await read.run({ input: ${JSON.stringify(turn("m-2"))}, host }),
        noReply: await read.run({ input: ${JSON.stringify(turn())}, host }),
        post: await post.run({ input: ${JSON.stringify(settled("slack:C1:100.1"))}, connections }),
        otherChat: await post.run({ input: ${JSON.stringify(settled("pr-acme/web-7"))}, connections }),
        unkeyed: await post.run({ input: ${JSON.stringify(settled(null))}, connections }),
        notAReply: await post.run({ input: ${JSON.stringify(settled("slack:C1:100.1", "user"))}, connections }),
      }));
    `,
  });
  expect(result).toEqual({
    read: {
      operation: "history",
      args: { sessionId: "chat-1", through: "m-2", limit: 1 },
    },
    noReply: { sessionId: "chat-1", key: null, messages: [] },
    post: {
      alias: "slack",
      action: "chat.postMessage",
      args: {
        body: {
          channel: "C1",
          thread_ts: "100.1",
          markdown_text: "The deploy is blocked on the migration.",
        },
      },
    },
    otherChat: { posted: false },
    unkeyed: { posted: false },
    notAReply: { posted: false },
  });
});

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}
