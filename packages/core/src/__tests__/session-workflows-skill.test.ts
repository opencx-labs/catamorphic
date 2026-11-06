import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseWorkflow } from "@catamorphic/parser";
import { expect, it } from "vitest";
import { SESSION_WORKFLOWS_SKILL } from "../session-workflows-skill.js";

it("the shipped self-wake recipe parses and returns executable host transitions", async () => {
  const recipe = /```typescript\n([\s\S]*?)```/.exec(
    SESSION_WORKFLOWS_SKILL,
  )?.[1];
  if (!recipe) throw new Error("Missing executable authoring example");
  const graph = parseWorkflow(recipe);
  expect(graph.nodes.length).toBeGreaterThan(1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-recipe-"));
  try {
    const workflowModule = path.resolve(
      import.meta.dirname,
      "../../../workflow/src/index.ts",
    );
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      recipe.replace('"@catamorphic/workflow"', JSON.stringify(workflowModule)),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { followUp } from "./recipe.ts";
      const calls = [];
      const host = { "catamorphic.sessions": Object.fromEntries(["deliver", "stop"].map(operation => [operation, args => ({ kind: "host-call", operation, args })])) };
      for (const step of followUp.steps) calls.push(await step.run({ input: { activationId: "timer", scheduledFor: "date", firedAt: "date" }, host }));
      console.log(JSON.stringify(calls));
    `,
    );
    const result = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 10000,
    });
    expect(JSON.parse(result.stdout)).toEqual([
      {
        kind: "host-call",
        operation: "deliver",
        args: {
          sessionId: "REPLACE_WITH_CURRENT_SESSION_ID",
          content:
            "Continue the requested follow-up. Inspect current state first.",
          mode: "queue",
          idempotencyKey: "timer:date",
        },
      },
      {
        kind: "host-call",
        operation: "stop",
        args: { idempotencyKey: "stop" },
      },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("the reusable completion recipe is quiet for unrelated sessions and reacts once per event identity", async () => {
  const recipe = [
    ...SESSION_WORKFLOWS_SKILL.matchAll(/```typescript\n([\s\S]*?)```/g),
  ][1]?.[1];
  if (!recipe) throw new Error("Missing completion example");
  expect(parseWorkflow(recipe).nodes.length).toBeGreaterThan(1);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "completion-recipe-"),
  );
  try {
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      recipe.replace(
        '"@catamorphic/workflow"',
        JSON.stringify(
          path.resolve(import.meta.dirname, "../../../workflow/src/index.ts"),
        ),
      ),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { childCompletion } from "./recipe.ts";
      const host = { "catamorphic.sessions": Object.fromEntries(["deliver", "close"].map(operation => [operation, args => ({ operation, args })])) };
      const run = parentSessionId => childCompletion.steps[0].run({ host, input: { id: "event-1", payload: { sessionId: "child", session: { parentSessionId, workStatus: "completed" } } } });
      console.log(JSON.stringify([await run("unrelated"), await run("REPLACE_WITH_PARENT_SESSION_ID")]));
    `,
    );
    const result = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 10000,
    });
    expect(JSON.parse(result.stdout)).toEqual([
      { matched: false },
      {
        operation: "deliver",
        args: {
          sessionId: "REPLACE_WITH_PARENT_SESSION_ID",
          mode: "message_only",
          attention: "required",
          content:
            "A child session finished its work. Inspect its result before continuing.",
          idempotencyKey: "child-finished:event-1",
        },
      },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("the reminder alerts without a model turn and keeps its original deadline and retry identity", async () => {
  const recipe = [
    ...SESSION_WORKFLOWS_SKILL.matchAll(/```typescript\n([\s\S]*?)```/g),
  ]
    .map((match) => match[1])
    .find((source) => source?.includes("export const remindUser"));
  if (!recipe) throw new Error("Missing user reminder recipe");
  expect(parseWorkflow(recipe).nodes.length).toBeGreaterThan(1);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "reminder-recipe-"),
  );
  try {
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      recipe.replace(
        '"@catamorphic/workflow"',
        JSON.stringify(
          path.resolve(import.meta.dirname, "../../../workflow/src/index.ts"),
        ),
      ),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { remindUser } from "./recipe.ts";
      const host = { "catamorphic.sessions": Object.fromEntries(["deliver", "stop"].map(operation => [operation, args => ({ operation, args })])) };
      const run = firedAt => remindUser.steps[0].run({ host, input: { activationId: "timer-1", scheduledFor: "2026-09-21T06:00:00Z", firedAt } });
      const first = await run("2026-09-21T06:00:00Z");
      const late = await run("2026-12-01T06:00:00Z");
      console.log(JSON.stringify({ first, late, stop: await remindUser.steps[1].run({ host }) }));
    `,
    );
    const result = JSON.parse(
      (
        await promisify(execFile)("bun", ["run", "verify.ts"], {
          cwd: directory,
          timeout: 10000,
        })
      ).stdout,
    );
    expect(result.first).toEqual({
      operation: "deliver",
      args: {
        sessionId: "REPLACE_WITH_CURRENT_SESSION_ID",
        content:
          "Reminder: review the proposal. Scheduled for 2026-09-21T06:00:00Z",
        mode: "message_only",
        attention: "required",
        idempotencyKey: "timer-1:2026-09-21T06:00:00Z",
      },
    });
    expect(result.late).toEqual(result.first);
    expect(result.stop).toEqual({
      operation: "stop",
      args: { idempotencyKey: "stop" },
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/** Runs one exported recipe's first boundary under bun with a fake host. */
async function runRecipe(input: {
  exportName: string;
  events: unknown[];
}): Promise<unknown> {
  const recipe = [
    ...SESSION_WORKFLOWS_SKILL.matchAll(/```typescript\n([\s\S]*?)```/g),
  ]
    .map((match) => match[1] ?? "")
    .find((source) => source.includes(`export const ${input.exportName}`));
  if (!recipe) throw new Error(`Missing ${input.exportName} example`);
  expect(parseWorkflow(recipe).nodes.length).toBeGreaterThan(1);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-recipe-"));
  try {
    const workflowModule = path.resolve(
      import.meta.dirname,
      "../../../workflow/src/index.ts",
    );
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      recipe.replace('"@catamorphic/workflow"', JSON.stringify(workflowModule)),
    );
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      import { ${input.exportName} as workflow } from "./recipe.ts";
      const host = { "catamorphic.sessions": Object.fromEntries(["deliver", "close"].map(operation => [operation, args => ({ operation, args })])) };
      const events = ${JSON.stringify(input.events)};
      const calls = [];
      for (const event of events) calls.push(await workflow.steps[0].run({ input: event, host }));
      console.log(JSON.stringify(calls));
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

it("the shipped pull-request recipe delivers to one keyed chat per pull request", async () => {
  const pullRequest = {
    payload: {
      body: {
        action: "opened",
        number: 7,
        repository: { full_name: "acme/web" },
        pull_request: {
          title: "Fix login",
          html_url: "https://github.test/pr/7",
          merged: false,
          draft: false,
        },
      },
    },
  };
  expect(
    await runRecipe({
      exportName: "reviewPullRequests",
      events: [pullRequest],
    }),
  ).toEqual([
    {
      operation: "deliver",
      args: {
        key: "pr-acme/web-7",
        workspace: { ref: "refs/pull/7/head", update: "reset" },
        title: "Review: Fix login",
        content:
          "Review the changes in https://github.test/pr/7 and summarize risks.",
        notification: { title: "Review ready", body: "Fix login" },
      },
    },
  ]);
});

it("the shipped close recipe closes the same project-keyed chat when a pull request closes", async () => {
  expect(
    await runRecipe({
      exportName: "closePullRequestChats",
      events: [
        {
          payload: {
            body: {
              action: "closed",
              number: 7,
              repository: { full_name: "acme/web" },
              pull_request: { merged: true },
            },
          },
        },
      ],
    }),
  ).toEqual([
    {
      operation: "close",
      args: { key: "pr-acme/web-7", idempotencyKey: "closed:pr-acme/web-7" },
    },
  ]);
});

it("the shipped onboarding recipe issues one key per joiner, stores it as theirs, and revokes it when they leave", async () => {
  const recipe = [
    ...SESSION_WORKFLOWS_SKILL.matchAll(/```typescript\n([\s\S]*?)```/g),
  ]
    .map((match) => match[1] ?? "")
    .find((source) => source.includes("export const issueEngineerKeys"));
  if (!recipe) throw new Error("Missing onboarding recipe");
  const graph = parseWorkflow(recipe);
  expect(graph.permissions).toEqual(["memberships:read", "secrets:write"]);
  expect(graph.triggers).toMatchObject([
    {
      kind: "directory.member-joined",
      config: { groups: ["engineering@example.com"] },
    },
  ]);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "onboarding-recipe-"),
  );
  try {
    await fs.writeFile(
      path.join(directory, "recipe.ts"),
      recipe.replace(
        '"@catamorphic/workflow"',
        JSON.stringify(
          path.resolve(import.meta.dirname, "../../../workflow/src/index.ts"),
        ),
      ),
    );
    // A fake ClickHouse Cloud API: one key a failed attempt left behind,
    // another member's key, and a fresh key on create.
    await fs.writeFile(
      path.join(directory, "verify.ts"),
      `
      process.env.CLICKHOUSE_ORGANIZATION_ID = "org-1";
      process.env.CLICKHOUSE_ADMIN_KEY = "admin-id:admin-secret";
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method ?? "GET", authorization: init.headers?.authorization, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
        const json = init.method === "POST"
          ? { result: { keyId: "key-2", keySecret: "secret-2" } }
          : { result: [{ id: "key-1", name: "work ada@example.com" }, { id: "key-9", name: "work bob@example.com" }] };
        return new Response(JSON.stringify(json), { status: 200 });
      };
      const { issueEngineerKeys, revokeLeaverKeys } = await import("./recipe.ts");
      const host = { "catamorphic.secrets": Object.fromEntries(["set", "delete"].map(operation => [operation, args => ({ operation, args })])) };
      const event = { id: "event-1", payload: { member: { id: "user-1", email: "ada@example.com", name: "Ada", domain: "example.com" }, groups: ["engineering@example.com"] } };
      const joined = await issueEngineerKeys.steps[0].run({ input: event, host });
      const issueCalls = calls.splice(0);
      const left = await revokeLeaverKeys.steps[0].run({ input: event, host });
      const deleted = await revokeLeaverKeys.steps[1].run({ input: left, host });
      console.log(JSON.stringify({ joined, issueCalls, revokeCalls: calls, deleted }));
    `,
    );
    const result = JSON.parse(
      (
        await promisify(execFile)("bun", ["run", "verify.ts"], {
          cwd: directory,
          timeout: 10000,
        })
      ).stdout,
    );
    const keys = "https://api.clickhouse.cloud/v1/organizations/org-1/keys";
    const authorization = `Basic ${Buffer.from("admin-id:admin-secret").toString("base64")}`;
    expect(result.joined).toEqual({
      operation: "set",
      args: {
        name: "CLICKHOUSE_API_KEY",
        value: "key-2:secret-2",
        member: "ada@example.com",
      },
    });
    expect(result.issueCalls).toEqual([
      { url: keys, method: "GET", authorization },
      { url: `${keys}/key-1`, method: "DELETE", authorization },
      {
        url: keys,
        method: "POST",
        authorization,
        body: {
          name: "work ada@example.com",
          roles: ["developer"],
          state: "enabled",
        },
      },
    ]);
    expect(result.revokeCalls).toEqual([
      { url: keys, method: "GET", authorization },
      { url: `${keys}/key-1`, method: "DELETE", authorization },
    ]);
    expect(result.deleted).toEqual({
      operation: "delete",
      args: { name: "CLICKHOUSE_API_KEY", member: "ada@example.com" },
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
