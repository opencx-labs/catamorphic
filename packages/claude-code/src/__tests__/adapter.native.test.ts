import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../index.js";
import {
  CLAUDE_SCENARIOS,
  runScenario,
  startScriptedModel,
} from "../testing/index.js";

/**
 * The pinned Claude Code CLI itself, against a scripted loopback model:
 * the scenarios whose replays matter most also pass live, so a CLI that
 * changed under a pinned SDK shows up here before a fixture goes stale.
 */
it.each(["simple-reply", "ask-user-question", "steer"])(
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
