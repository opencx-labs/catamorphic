import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { InProcessRunner } from "@catamorphic/agent-runner";
import { expect, it } from "vitest";
import { type ClaudeQueryHandle, createClaudeCodeAdapter } from "../index.js";
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

async function nativeGrantCase(input: { timeout: boolean }): Promise<void> {
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
  let releaseModel = () => {};
  const blocked = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const model = await startScriptedModel({
    reply: async (request) => {
      const bearer = request.authorization ?? "";
      seen.push(bearer);
      if (input.timeout) {
        await blocked;
        return { blocks: [{ type: "text", text: "released during cleanup" }] };
      }
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
  let handle: ClaudeQueryHandle | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClosed = false;
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  try {
    const outcome = await driveAttempt({
      runner: new InProcessRunner({
        version: "native",
        adapters: {
          "claude-code": createClaudeCodeAdapter({
            query: (parameters) => {
              expect(
                parameters.options.env?.CLAUDE_CODE_API_KEY_HELPER_TTL_MS,
              ).toBe("300000");
              handle = sdkQuery({
                ...parameters,
                options: {
                  ...parameters.options,
                  spawnClaudeCodeProcess: (options) => {
                    launches += 1;
                    const process = spawn(options.command, options.args, {
                      cwd: options.cwd,
                      env: options.env,
                      signal: options.signal,
                      stdio: ["pipe", "pipe", "pipe"],
                      windowsHide: true,
                    });
                    child = process;
                    process.once("close", () => {
                      childClosed = true;
                      resolveClosed();
                    });
                    return process;
                  },
                },
              });
              return handle;
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
      timeoutMs: input.timeout ? 2_000 : 45_000,
    });
    expect(launches).toBe(1);
    expect(seen).toEqual([
      "Bearer old-grant",
      "Bearer old-grant",
      "Bearer new-grant",
    ]);
    expect(outcome.completed?.status).toBe("completed");
  } finally {
    try {
      // The driver can throw before the runner exits. Own the actual SDK
      // query and OS child, then join it before removing its working files.
      void handle?.interrupt({ cancelQueued: true }).catch(() => {});
      handle?.close();
      if (child) {
        child.stdin.end();
        const term = setTimeout(() => child?.kill("SIGTERM"), 1_000);
        const kill = setTimeout(() => child?.kill("SIGKILL"), 3_000);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("The native Claude child did not close")),
                6_000,
              );
            }),
          ]);
          expect(childClosed).toBe(true);
        } finally {
          clearTimeout(term);
          clearTimeout(kill);
          clearTimeout(timer);
        }
      }
    } finally {
      releaseModel();
      await model.close();
      if (!child || childClosed)
        await rm(root, { recursive: true, force: true });
    }
  }
}

it("refreshes a cached model grant after a 401 in the same pinned CLI process", async () => {
  await nativeGrantCase({ timeout: false });
}, 60_000);

it("closes and joins the pinned Claude child when its host driver times out", async () => {
  await expect(nativeGrantCase({ timeout: true })).rejects.toThrow(
    "did not exit in time",
  );
}, 20_000);
