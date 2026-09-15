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
          mode: "next_turn",
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
      const host = { "catamorphic.sessions": { deliver: args => ({ operation: "deliver", args }) } };
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
