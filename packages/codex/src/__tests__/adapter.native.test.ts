import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { expect, it } from "vitest";
import { createCodexAdapter } from "../adapter.js";
import { pinnedCodexCommand } from "../testing/pinned.js";
import { type CodexTransport, processTransport } from "../transport.js";
import { driveAttempt, NativeStore } from "./replay/driver.js";
import { cleanup, eventsOf, replayScenario } from "./replay/harness.js";
import { modelServer, recordScenario } from "./replay/record-scenario.js";
import { attemptBase, scenario } from "./replay/scenarios.js";

/** Events with the ids a fresh run allocates anew replaced. */
function shape(events: HarnessEvent[]): unknown[] {
  return JSON.parse(
    JSON.stringify(events.filter((event) => event.type !== "diagnostic"))
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "<id>",
      )
      .replace(/rollout-[\dT-]+-<id>/g, "rollout-<stamp>-<id>")
      .replace(/sessions\/\d{4}\/\d{2}\/\d{2}\//g, "sessions/<date>/"),
  );
}

it.each(["simple-reply", "host-and-mcp-tools", "user-question"] as const)(
  "the pinned Codex CLI still produces the recorded %s transcript's events",
  async (name) => {
    const command = pinnedCodexCommand();
    const live = await recordScenario({
      scenario: scenario(name),
      command,
      cliVersion: execFileSync(command, ["--version"], { encoding: "utf8" }),
    });
    const replayed = await replayScenario(name);
    try {
      expect(shape(live.results[0]?.events ?? [])).toEqual(
        shape(eventsOf(replayed)),
      );
    } finally {
      await cleanup(replayed);
    }
  },
  60_000,
);

async function nativeGrantCase(input: { timeout: boolean }): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codex-native-grant-")),
  );
  const grants = path.join(root, "model-key");
  await Promise.all([mkdir(path.join(root, "work")), mkdir(grants)]);
  await writeFile(path.join(grants, "1"), "old-grant");
  const seen: string[] = [];
  let releaseModel = () => {};
  const blocked = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const problems: string[] = [];
  const model = await modelServer(
    [
      { items: [{ call: "read_notes", args: {} }] },
      { items: [{ message: "continued after rotation" }] },
    ],
    problems,
    {
      authorize: async ({ authorization }) => {
        seen.push(authorization);
        if (input.timeout) {
          await blocked;
          return true;
        }
        if (seen.length === 1) {
          // Admit this request, then replace the claim before the same CLI
          // continues its tool loop and needs another model answer.
          await writeFile(path.join(grants, "2"), "new-grant");
          return true;
        }
        return authorization === "Bearer new-grant";
      },
    },
  );
  let launches = 0;
  let transport: CodexTransport | undefined;
  let processExited = false;
  let resolveExited = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  try {
    const attempt = attemptBase(
      {
        root,
        model: model.url,
        node: process.execPath,
        fixtures: "unused",
        command: pinnedCodexCommand(),
      },
      { ordinal: 1, text: "Read notes and continue" },
    );
    attempt.hostTools = [
      {
        name: "read_notes",
        description: "Read notes",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
    attempt.env = {
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    };
    const result = await driveAttempt({
      adapter: createCodexAdapter({
        transport: (input) => {
          launches += 1;
          transport = processTransport({
            ...input,
            onExit: (exit) => {
              processExited = true;
              resolveExited();
              input.onExit(exit);
            },
          });
          return transport;
        },
      }),
      attempt,
      store: new NativeStore(),
      script: { tool: () => ({ notes: "continue" }) },
      timeoutMs: input.timeout ? 2_000 : 45_000,
    });
    expect(launches).toBe(1);
    expect(seen).toEqual([
      "Bearer old-grant",
      "Bearer old-grant",
      "Bearer new-grant",
    ]);
    expect(problems).toEqual([]);
    expect(
      result.events.find((event) => event.type === "turn.completed"),
    ).toMatchObject({ status: "completed" });
  } finally {
    try {
      // The real transport already escalates EOF to TERM/KILL. Its onExit
      // joins the OS process even if driveAttempt threw its deadline.
      transport?.close();
      if (transport) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("The native Codex process did not exit")),
                6_000,
              );
            }),
          ]);
          expect(processExited).toBe(true);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      releaseModel();
      await model.close();
      if (!transport || processExited)
        await rm(root, { recursive: true, force: true });
    }
  }
}

it("refreshes a cached model grant after a 401 in the same pinned app-server process", async () => {
  await nativeGrantCase({ timeout: false });
}, 60_000);

it("closes and joins the pinned Codex process when its host driver times out", async () => {
  await expect(nativeGrantCase({ timeout: true })).rejects.toThrow(
    "did not finish",
  );
}, 20_000);
