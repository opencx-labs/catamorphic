import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../index.js";
import {
  CLAUDE_SCENARIOS,
  driveAttempt,
  runScenario,
  ScriptedNativeState,
  scenarioAttempt,
  startScriptedModel,
} from "../testing/index.js";

/**
 * The pinned Claude Code CLI itself, against a scripted loopback model:
 * the scenarios whose replays matter most also pass live, so a CLI that
 * changed under a pinned SDK shows up here before a fixture goes stale.
 */
it.each(["simple-reply", "ask-user-question", "steer", "retry-same-input"])(
  "the pinned CLI passes %s live",
  async (name) => {
    const scenario = CLAUDE_SCENARIOS.find((entry) => entry.name === name);
    if (!scenario) throw new Error(`No scenario ${name}`);
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), `claude-live-${name}-`)),
    );
    const directories = {
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
    let cwd = directories.here.cwd;
    const model = await startScriptedModel({
      reply: (request) => scenario.model(request, { cwd }),
    });
    try {
      const outcomes = await runScenario({
        scenario,
        directories,
        modelUrl: model.url,
        fixtureServer: { transport: "stdio", command: "unused" },
        onAttempt: (attempt) => {
          cwd = attempt.cwd;
        },
        runner: () =>
          new InProcessRunner({
            adapters: { "claude-code": createClaudeCodeAdapter() },
            version: "live",
          }),
        timeoutMs: 45_000,
      });
      scenario.check(outcomes);
      expect(model.requests.length).toBeGreaterThan(0);
    } finally {
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

it("refreshes a cached model grant after a 401 in the same pinned CLI process", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "claude-native-grant-")),
  );
  const place = {
    cwd: path.join(root, "work"),
    state: path.join(root, "state"),
    home: path.join(root, "home"),
  };
  const grants = path.join(place.state, "model-key");
  await Promise.all([
    mkdir(place.cwd),
    mkdir(place.home),
    mkdir(grants, { recursive: true }),
  ]);
  await writeFile(
    path.join(place.cwd, "readme.txt"),
    "continue after rotation",
  );
  await writeFile(path.join(grants, "1"), "old-grant");
  const seen: string[] = [];
  const model = await startScriptedModel({
    reply: async (request) => {
      const bearer = request.authorization ?? "";
      seen.push(bearer);
      if (request.index === 0) {
        // The first request was admitted. Replace its claim while its model
        // answer runs a tool, so the next request uses the CLI's cached key.
        await writeFile(path.join(grants, "2"), "new-grant");
        return {
          blocks: [
            {
              type: "tool_use",
              id: "toolu_grant",
              name: "Read",
              input: { file_path: path.join(place.cwd, "readme.txt") },
            },
          ],
        };
      }
      if (bearer !== "Bearer new-grant")
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message: "The old claim was revoked",
          },
        };
      return { blocks: [{ type: "text", text: "continued after rotation" }] };
    },
  });
  let launches = 0;
  try {
    const outcome = await driveAttempt({
      runner: new InProcessRunner({
        version: "native",
        adapters: {
          "claude-code": createClaudeCodeAdapter({
            query: (parameters) => {
              launches += 1;
              expect(
                parameters.options.env?.CLAUDE_CODE_API_KEY_HELPER_TTL_MS,
              ).toBe("300000");
              return sdkQuery(parameters);
            },
          }),
        },
      }),
      attempt: scenarioAttempt({
        context: {
          ...place,
          modelUrl: model.url,
          fixtureServer: { transport: "stdio", command: "unused" },
          previous: [],
        },
        scenario: "grant-refresh",
        turn: 1,
        text: "Read the file and continue",
      }),
      host: {},
      nativeState: new ScriptedNativeState(),
      timeoutMs: 45_000,
    });
    expect(launches).toBe(1);
    expect(seen).toEqual([
      "Bearer old-grant",
      "Bearer old-grant",
      "Bearer new-grant",
    ]);
    expect(outcome.completed?.status).toBe("completed");
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
