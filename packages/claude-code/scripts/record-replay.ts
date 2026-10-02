/**
 * Records the replay fixtures in src/testing/fixtures from the real pinned
 * Claude Code CLI, driven against a scripted loopback Anthropic Messages
 * API (no network, no credentials):
 *
 *   bun run --cwd packages/claude-code record:claude-replay [scenario…]
 *
 * Each scenario runs through the real adapter on a real in-process runner;
 * its checks must pass before its fixture is written.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessRunner } from "../../agent-runner/src/index.ts";
import { createClaudeCodeAdapter } from "../src/index.ts";
import {
  CLAUDE_SCENARIOS,
  type ClaudeReplayAttempt,
  type ClaudeReplayTranscript,
  FIXTURE_MCP_SERVER,
  recordingQuery,
  runScenario,
  scenarioTokens,
  startScriptedModel,
  tokenize,
} from "../src/testing/index.ts";

const only = process.argv.slice(2);
const sdkPackage = JSON.parse(
  await readFile(
    new URL(
      "../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixtures = new URL("../src/testing/fixtures/", import.meta.url).pathname;

let failed = false;
for (const scenario of CLAUDE_SCENARIOS) {
  if (only.length > 0 && !only.includes(scenario.name)) continue;
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), `claude-replay-${scenario.name}-`)),
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
  const attempts: ClaudeReplayAttempt[] = [];
  try {
    const outcomes = await runScenario({
      scenario,
      directories,
      modelUrl: model.url,
      fixtureServer: {
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE_MCP_SERVER],
      },
      onAttempt: (attempt) => {
        cwd = attempt.cwd;
      },
      runner: () =>
        new InProcessRunner({
          adapters: {
            "claude-code": createClaudeCodeAdapter({
              query: recordingQuery({ attempts }),
            }),
          },
          version: "record",
        }),
      timeoutMs: 90_000,
    });
    for (const [index, outcome] of outcomes.entries()) {
      const attempt = attempts[index];
      if (attempt) attempt.events = outcome.events;
    }
    scenario.check(outcomes);
    const init = attempts
      .flatMap((attempt) => attempt.messages)
      .find(
        (message) => message.type === "system" && message.subtype === "init",
      );
    const transcript: ClaudeReplayTranscript = {
      provider: "claude-code",
      sdkVersion: String(sdkPackage.version),
      cliVersion:
        init?.type === "system" && init.subtype === "init"
          ? init.claude_code_version
          : null,
      scenario: scenario.name,
      source: "recorded",
      attempts,
    };
    const json = tokenize(`${JSON.stringify(transcript, null, 2)}\n`, {
      ...scenarioTokens({ directories, modelUrl: model.url }),
      // The CLI's own temporary files (resume copies, task output).
      tmp: tmpdir().replace(/\/$/, ""),
      "tmp-real": await realpath(tmpdir()),
      "cli-tmp": `/private/tmp/claude-${process.getuid?.() ?? 0}`,
    });
    await writeFile(path.join(fixtures, `${scenario.name}.json`), json);
    console.log(
      `${scenario.name}: ${attempts.length} attempt(s), ${attempts.reduce((sum, attempt) => sum + attempt.messages.length, 0)} entries`,
    );
  } catch (error) {
    failed = true;
    if (process.env.RECORD_FAILED_DIR)
      await writeFile(
        path.join(process.env.RECORD_FAILED_DIR, `${scenario.name}.json`),
        JSON.stringify(attempts, null, 2),
      );
    console.error(`${scenario.name} failed:`, error);
    for (const [index, attempt] of attempts.entries())
      console.error(
        `  attempt ${index + 1} events:`,
        JSON.stringify(attempt.events ?? []).slice(0, 4_000),
      );
    console.error(
      "  model requests:",
      model.requests.map((request) =>
        JSON.stringify(request.body.messages).slice(-400),
      ),
    );
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
