import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../index.js";
import {
  CLAUDE_SCENARIOS,
  loadClaudeTranscript,
  ReplayDivergenceError,
  replayQuery,
  runScenario,
  type ScenarioDirectories,
  scenarioTokens,
} from "../testing/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function directories(): Promise<ScenarioDirectories> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "claude-replay-")),
  );
  roots.push(root);
  return {
    here: {
      cwd: path.join(root, "work"),
      state: path.join(root, "state"),
      home: path.join(root, "home"),
    },
    elsewhere: {
      cwd: path.join(root, "work-elsewhere"),
      state: path.join(root, "state-elsewhere"),
      home: path.join(root, "home-elsewhere"),
    },
  };
}

const MODEL_URL = "http://127.0.0.1:9";

/**
 * Every recorded scenario through the real adapter on a real runner, with
 * only the SDK transport replaced (ADR 0198): the scenario's own checks
 * pass, and the adapter emits exactly what it emitted against the real CLI.
 */
describe.each(
  CLAUDE_SCENARIOS.map((scenario) => ({ scenario, name: scenario.name })),
)("replayed $name", ({ scenario }) => {
  it(scenario.description, async () => {
    const places = await directories();
    const transcript = await loadClaudeTranscript({
      scenario: scenario.name,
      tokens: scenarioTokens({ directories: places, modelUrl: MODEL_URL }),
    });
    expect(transcript.source).toBe("recorded");
    const query = replayQuery(transcript);
    const outcomes = await runScenario({
      scenario,
      directories: places,
      modelUrl: MODEL_URL,
      fixtureServer: { transport: "stdio", command: "fixture-mcp-server" },
      runner: () =>
        new InProcessRunner({
          adapters: { "claude-code": createClaudeCodeAdapter({ query }) },
          version: "replay",
        }),
      timeoutMs: 20_000,
    });
    scenario.check(outcomes);
    expect(outcomes).toHaveLength(transcript.attempts.length);
    for (const [index, outcome] of outcomes.entries())
      expect(outcome.events).toEqual(transcript.attempts[index]?.events);
  });
});

it("an MCP elicitation becomes an elicitation request (authored from the SDK's types)", async () => {
  const places = await directories();
  const base = CLAUDE_SCENARIOS.find((entry) => entry.name === "simple-reply");
  const step = base?.attempts[0];
  if (!base || !step) throw new Error("simple-reply is missing");
  const transcript = await loadClaudeTranscript({
    scenario: "simple-reply",
    tokens: scenarioTokens({ directories: places, modelUrl: MODEL_URL }),
  });
  const first = transcript.attempts[0];
  if (!first) throw new Error("no attempt");
  transcript.source = "authored";
  const init = first.messages.findIndex(
    (entry) => entry.type === "system" && entry.subtype === "init",
  );
  first.messages.splice(init + 1, 0, {
    type: "replay.elicitation",
    request: {
      serverName: "fixture",
      message: "Which account should I use?",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { account: { type: "string" } },
      },
    },
    requestId: "elicit-1",
    result: { action: "accept", content: { account: "main" } },
  });
  const outcomes = await runScenario({
    scenario: {
      ...base,
      attempts: [
        {
          ...step,
          host: {
            answer: ({ request }) =>
              request.kind === "elicitation"
                ? {
                    kind: "elicitation",
                    action: "accept",
                    content: { account: "main" },
                  }
                : undefined,
          },
        },
      ],
    },
    directories: places,
    modelUrl: MODEL_URL,
    fixtureServer: { transport: "stdio", command: "fixture-mcp-server" },
    runner: () =>
      new InProcessRunner({
        adapters: {
          "claude-code": createClaudeCodeAdapter({
            query: replayQuery(transcript),
          }),
        },
        version: "replay",
      }),
  });
  const [outcome] = outcomes;
  expect(outcome?.completed?.status).toBe("completed");
  const opened = outcome?.events.find(
    (event) => event.type === "request.opened",
  );
  expect(opened).toMatchObject({
    key: "elicitation:elicit-1",
    request: {
      kind: "elicitation",
      title: "Which account should I use?",
      origin: { kind: "mcp", id: "fixture" },
      elicitation: {
        server: "fixture",
        message: "Which account should I use?",
        schema: { type: "object", properties: { account: { type: "string" } } },
      },
    },
  });
});

it("a replay refuses an adapter that asks the SDK for something else", async () => {
  const places = await directories();
  const scenario = CLAUDE_SCENARIOS.find(
    (entry) => entry.name === "simple-reply",
  );
  if (!scenario) throw new Error("simple-reply is missing");
  const transcript = await loadClaudeTranscript({
    scenario: "simple-reply",
    tokens: scenarioTokens({ directories: places, modelUrl: MODEL_URL }),
  });
  const first = transcript.attempts[0];
  if (!first) throw new Error("no attempt");
  first.outbound = { ...first.outbound, model: "another-model" };
  const outcomes = await runScenario({
    scenario,
    directories: places,
    modelUrl: MODEL_URL,
    fixtureServer: { transport: "stdio", command: "fixture-mcp-server" },
    runner: () =>
      new InProcessRunner({
        adapters: {
          "claude-code": createClaudeCodeAdapter({
            query: replayQuery(transcript),
          }),
        },
        version: "replay",
      }),
  });
  const completed = outcomes[0]?.completed;
  expect(completed?.status).toBe("failed");
  expect(completed?.error?.message).toContain("differs from the recording");
  expect(new ReplayDivergenceError("x").name).toBe("ReplayDivergenceError");
});
