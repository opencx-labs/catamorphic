import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  HarnessAdapter,
} from "@catamorphic/agent-protocol/runner";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../index.js";
import {
  type AttemptOutcome,
  driveAttempt,
  itemsOf,
  type ScenarioContext,
  type ScriptedModel,
  ScriptedNativeState,
  type ScriptedRequest,
  scenarioAttempt,
  startScriptedModel,
} from "../testing/index.js";

/**
 * A thread's CLI kept warm between attempts (ADR 0222), with the pinned
 * Claude Code CLI against a scripted loopback model: a matching attempt
 * joins the live CLI, which never loads the transcript again; another
 * launch or a history that moved on starts a new CLI from Work's copy.
 */

let root: string;
let model: ScriptedModel;
let context: ScenarioContext;
let adapter: HarnessAdapter;
let nativeState: ScriptedNativeState;
/** Each test's own thread. */
let scenario: string;

function sent(request: ScriptedRequest): string {
  return JSON.stringify(request.body.messages ?? null);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "claude-warm-")));
  context = {
    cwd: path.join(root, "work"),
    state: path.join(root, "state"),
    home: path.join(root, "home"),
    modelUrl: "",
    fixtureServer: { transport: "stdio", command: "unused" },
    previous: [],
  };
  await Promise.all(
    [context.cwd, context.state, context.home].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await writeFile(path.join(context.state, "model-key"), "fixture-key");
  model = await startScriptedModel({
    reply: (request) => {
      const text = sent(request);
      if (text.includes("Fail this turn"))
        return {
          error: {
            status: 400,
            type: "invalid_request_error",
            message: "The scripted model refused this turn.",
          },
        };
      // A long answer the person stops while it streams.
      if (text.includes("Write a long story") && !text.includes("Which word"))
        return {
          blocks: [{ type: "text", text: "Once upon a time, far away." }],
          holdMs: 8_000,
        };
      if (text.includes("Which word"))
        return {
          blocks: [
            {
              type: "text",
              text: text.includes("Noted: mango.")
                ? "The word was mango."
                : "I do not know.",
            },
          ],
        };
      return { blocks: [{ type: "text", text: "Noted: mango." }] };
    },
  });
  context.modelUrl = model.url;
  adapter = createClaudeCodeAdapter({ warm: { idleMs: 60_000, max: 2 } });
  nativeState = new ScriptedNativeState();
  scenario = `warm-${path.basename(root)}`;
});

afterEach(async () => {
  await adapter.dispose?.();
  await model.close();
  await rm(root, { recursive: true, force: true });
});

function run(attempt: AttemptStart): Promise<AttemptOutcome> {
  return driveAttempt({
    runner: new InProcessRunner({
      adapters: { "claude-code": adapter },
      version: "warm",
    }),
    attempt,
    host: {},
    nativeState,
    timeoutMs: 45_000,
  });
}

function reply(outcome: AttemptOutcome): string {
  return itemsOf(outcome)
    .filter((entry) => entry.item.kind === "assistant_message")
    .map((entry) => String(entry.item.text))
    .join("\n");
}

/** The next turn of the previous attempt's thread, as Work would start it. */
function followUp(
  first: AttemptOutcome,
  overrides: Partial<AttemptStart> & {
    turn?: number;
    lastTurnRef?: { id: string; strength: "strong" };
  } = {},
): AttemptStart {
  const { lastTurnRef, turn = 2, ...rest } = overrides;
  const thread = first.thread;
  if (!thread) throw new Error("The first attempt named no thread");
  return scenarioAttempt({
    context,
    scenario,
    turn,
    text: "Which word did I ask you to remember?",
    thread: {
      mode: "restore",
      providerThreadId: first.attempt.thread.providerThreadId,
      nativeRef: thread,
      ...((lastTurnRef ?? first.completed?.ref)
        ? { lastTurnRef: lastTurnRef ?? first.completed?.ref }
        : {}),
    },
    overrides: rest,
  });
}

function loaded(outcome: AttemptOutcome): boolean {
  return outcome.calls.some((call) => call.kind === "native_state.load");
}

it("a thread's next attempt joins its warm CLI", async () => {
  const first = await run(
    scenarioAttempt({
      context,
      scenario,
      turn: 1,
      text: "Remember the word mango",
    }),
  );
  expect(first.completed?.status).toBe("completed");
  const second = await run(followUp(first));
  expect(second.completed?.status).toBe("completed");
  expect(reply(second)).toBe("The word was mango.");
  expect(second.thread?.id).toBe(first.thread?.id);
  // Nothing was read back: the live CLI still held the conversation.
  expect(loaded(second)).toBe(false);
  // Its transcript still reaches Work, for any later cold resume.
  expect(
    second.calls.some(
      (call) =>
        call.kind === "native_state.append" &&
        JSON.stringify(call.entries as JsonValue).includes(
          "The word was mango.",
        ),
    ),
  ).toBe(true);
}, 90_000);

it("another launch, or a history that moved on, starts a new CLI", async () => {
  const first = await run(
    scenarioAttempt({
      context,
      scenario,
      turn: 1,
      text: "Remember the word mango",
    }),
  );
  const changed = await run(
    followUp(first, { systemPrompt: "Another agent's instructions." }),
  );
  expect(loaded(changed)).toBe(true);
  expect(reply(changed)).toBe("The word was mango.");

  const third = await run(
    followUp(changed, {
      turn: 3,
      // Work recorded a later turn than this CLI's: it ran elsewhere.
      lastTurnRef: { id: "assistant-from-elsewhere", strength: "strong" },
      systemPrompt: "Another agent's instructions.",
    }),
  );
  expect(loaded(third)).toBe(true);
  expect(third.completed?.status, JSON.stringify(third.completed)).toBe(
    "completed",
  );
}, 120_000);

it("an interrupt withdraws the steers its turn never read, so the next turn does not run them", async () => {
  const steered = "The background tests passed: pineapple.";
  const first = await driveAttempt({
    runner: new InProcessRunner({
      adapters: { "claude-code": adapter },
      version: "warm",
    }),
    attempt: scenarioAttempt({
      context,
      scenario,
      turn: 1,
      text: "Remember the word mango. Write a long story",
    }),
    host: {
      onEvent: (() => {
        let steeredOnce = false;
        return (event, control) => {
          // Mid-answer: no step boundary comes before the person stops it.
          if (event.type !== "item.delta" || steeredOnce) return;
          steeredOnce = true;
          control.steer({ itemId: "item-late-steer", text: steered });
          setTimeout(() => control.interrupt("The person stopped it"), 500);
        };
      })(),
    },
    nativeState,
    timeoutMs: 45_000,
  });
  expect(first.completed?.status).toBe("interrupted");
  // Never read: Work runs it as a turn of its own.
  expect(
    first.events.some(
      (event) =>
        event.type === "input.consumed" &&
        event.itemIds.includes("item-late-steer"),
    ),
  ).toBe(false);
  const second = await run(followUp(first));
  expect(second.completed?.status).toBe("completed");
  // The warm CLI served it, and its queue no longer held the steer.
  expect(loaded(second)).toBe(false);
  expect(
    model.requests.filter((request) => sent(request).includes("pineapple")),
  ).toEqual([]);
}, 90_000);

it("takes a message steered while its CLI still starts, after the attempt's own input", async () => {
  const outcome = await driveAttempt({
    runner: new InProcessRunner({
      adapters: { "claude-code": adapter },
      version: "warm",
    }),
    attempt: scenarioAttempt({
      context,
      scenario,
      turn: 1,
      text: "Remember the word mango",
    }),
    host: {
      afterStart: (control) =>
        control.steer({ itemId: "item-early-steer", text: "Also kiwi." }),
    },
    nativeState,
    timeoutMs: 45_000,
  });
  expect(outcome.completed?.status).toBe("completed");
  // Taken, never refused: a refusal would stop the attempt for it.
  expect([...outcome.acks.values()].every((error) => !error)).toBe(true);
  expect(
    outcome.events.some(
      (event) =>
        event.type === "input.consumed" &&
        event.itemIds.includes("item-early-steer"),
    ),
  ).toBe(true);
  const asked = model.requests.map(sent).join("\n");
  expect(asked.indexOf("Remember the word mango")).toBeGreaterThan(-1);
  expect(asked.indexOf("Remember the word mango")).toBeLessThan(
    asked.indexOf("Also kiwi."),
  );
}, 90_000);

it("a failed turn's CLI does not serve the retry", async () => {
  const failed = await run(
    scenarioAttempt({
      context,
      scenario,
      turn: 1,
      text: "Remember the word mango. Fail this turn.",
    }),
  );
  expect(failed.completed?.status).toBe("failed");
  const retry = await run(followUp(failed));
  expect(loaded(retry)).toBe(true);
}, 90_000);

it("a CLI writing a debug log is not kept warm, so its log covers its attempt alone", async () => {
  const debugFile = path.join(root, "sign-in-retry.log");
  const logged = { options: { memory: false, debugFile } };
  const first = await run(
    scenarioAttempt({
      context,
      scenario,
      turn: 1,
      text: "Remember the word mango",
      overrides: logged,
    }),
  );
  expect(first.completed?.status).toBe("completed");
  expect((await readFile(debugFile, "utf8")).length).toBeGreaterThan(0);
  // Even the same launch starts a new CLI from Work's copy.
  const second = await run(followUp(first, logged));
  expect(loaded(second)).toBe(true);
  expect(reply(second)).toBe("The word was mango.");
}, 90_000);
