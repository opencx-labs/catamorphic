import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AttemptStart } from "@catamorphic/agent-protocol/runner";
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
  scenarioAttempt,
  startScriptedModel,
} from "../testing/index.js";

/**
 * A sign-in through a resumed thread (ADR 0275), with the pinned Claude
 * Code CLI against a scripted loopback model. A resumed CLI runs in the
 * temporary home the SDK writes Work's stored transcript to, with a copy
 * of the sign-in that cannot refresh; it must still use the sign-in's own
 * store, where the token is refreshed and where another Claude Code on the
 * machine leaves the token it renewed. Nothing leaves the machine: every
 * other host is refused, so the test never refreshes against Anthropic.
 */

let root: string;
let model: ScriptedModel;
let context: ScenarioContext;
let nativeState: ScriptedNativeState;

/** What Claude Code keeps for a claude.ai sign-in. */
async function signIn(accessToken: string): Promise<void> {
  await writeFile(
    path.join(context.home, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: "fixture-refresh-token",
        // Unexpired: the CLI starts with it and meets the 401 first.
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        subscriptionType: "max",
      },
    }),
    { mode: 0o600 },
  );
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "claude-sign-in-")));
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
  model = await startScriptedModel({
    reply: async (request) => {
      if (request.authorization === "Bearer revoked-token") {
        // Another Claude Code on this machine renewed the sign-in, which
        // revoked the token this CLI started with.
        await signIn("renewed-token");
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message: "OAuth access token has been revoked.",
          },
        };
      }
      return { blocks: [{ type: "text", text: "Noted." }] };
    },
  });
  context.modelUrl = model.url;
  nativeState = new ScriptedNativeState();
});

afterEach(async () => {
  await model.close();
  await rm(root, { recursive: true, force: true });
});

function signedIn(input: {
  turn: number;
  thread?: AttemptStart["thread"];
}): AttemptStart {
  return scenarioAttempt({
    context,
    scenario: `sign-in-${path.basename(root)}`,
    turn: input.turn,
    text: input.turn === 1 ? "Remember the word mango" : "Which word?",
    ...(input.thread ? { thread: input.thread } : {}),
    overrides: {
      modelAccess: { kind: "sign_in", home: context.home },
      env: {
        ANTHROPIC_BASE_URL: model.url,
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      },
    },
  });
}

function run(attempt: AttemptStart): Promise<AttemptOutcome> {
  return driveAttempt({
    // A runner per attempt, its CLI started cold: the second attempt
    // resumes from Work's copy, as a chat does after its CLI went idle.
    runner: new InProcessRunner({
      adapters: { "claude-code": createClaudeCodeAdapter() },
      version: "sign-in",
    }),
    attempt,
    host: {},
    nativeState,
    timeoutMs: 45_000,
  });
}

it("a resumed thread's CLI takes up the sign-in another Claude Code renewed", async () => {
  await signIn("first-token");
  const first = await run(signedIn({ turn: 1 }));
  expect(first.completed?.status, JSON.stringify(first.completed)).toBe(
    "completed",
  );
  const thread = first.thread;
  if (!thread) throw new Error("The first attempt named no thread");

  await signIn("revoked-token");
  const second = await run(
    signedIn({
      turn: 2,
      thread: {
        mode: "restore",
        providerThreadId: first.attempt.thread.providerThreadId,
        nativeRef: thread,
        ...(first.completed?.ref ? { lastTurnRef: first.completed.ref } : {}),
      },
    }),
  );
  // It resumed from Work's copy, in the SDK's temporary home.
  expect(second.calls.some((call) => call.kind === "native_state.load")).toBe(
    true,
  );
  expect(second.completed?.status, JSON.stringify(second.completed)).toBe(
    "completed",
  );
  expect(
    itemsOf(second).some(
      (entry) =>
        entry.item.kind === "assistant_message" && entry.item.text === "Noted.",
    ),
  ).toBe(true);
  expect(model.requests.map((request) => request.authorization)).toEqual([
    "Bearer first-token",
    "Bearer revoked-token",
    "Bearer renewed-token",
  ]);
}, 90_000);
