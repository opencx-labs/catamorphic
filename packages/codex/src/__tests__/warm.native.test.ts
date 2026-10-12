import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { expect, it } from "vitest";
import { createCodexAdapter } from "../adapter.js";
import { pinnedCodexCommand } from "../testing/pinned.js";
import {
  type AttemptResult,
  driveAttempt,
  NativeStore,
} from "./replay/driver.js";
import { MCP_FIXTURES, modelServer } from "./replay/record-scenario.js";
import { attemptBase, threadOf, WORKSPACE_FILES } from "./replay/scenarios.js";

/**
 * A thread's Codex kept warm between attempts (ADR 0222), with the pinned
 * Codex CLI against a scripted loopback Responses API: the next attempt
 * runs on the loaded thread, never restoring its rollout, and the turn's
 * rollout lines still reach Work before it settles.
 */

function completed(result: AttemptResult) {
  return result.events.find(
    (event): event is Extract<HarnessEvent, { type: "turn.completed" }> =>
      event.type === "turn.completed",
  );
}

it("a thread's next attempt runs on its warm Codex", async () => {
  const root = await mkdtemp(
    path.join(await realpath(tmpdir()), "codex-warm-"),
  );
  const problems: string[] = [];
  const model = await modelServer(
    [
      { items: [{ message: "Noted: the number is 7." }] },
      {
        items: [{ message: "The number was 7." }],
        expectInput: ["Remember the number 7.", "Noted: the number is 7."],
      },
    ],
    problems,
  );
  const adapter = createCodexAdapter({ warm: { idleMs: 60_000, max: 2 } });
  try {
    await mkdir(path.join(root, "work"), { recursive: true });
    for (const [file, text] of Object.entries(WORKSPACE_FILES))
      await writeFile(path.join(root, "work", file), text);
    await writeFile(path.join(root, "model-key"), "fixture-model-key");
    const context = {
      root,
      model: model.url,
      node: process.execPath,
      fixtures: MCP_FIXTURES,
      command: pinnedCodexCommand(),
    };
    const store = new NativeStore();
    const first = await driveAttempt({
      adapter,
      attempt: attemptBase(context, {
        ordinal: 1,
        text: "Remember the number 7.",
      }),
      store,
    });
    expect(completed(first)?.status).toBe("completed");
    const thread = threadOf(first);
    const lastTurnRef = completed(first)?.ref;
    const second = await driveAttempt({
      adapter,
      attempt: {
        ...attemptBase(context, {
          ordinal: 2,
          text: "Which number was it?",
        }),
        thread: {
          mode: "restore",
          providerThreadId: "thread-1",
          nativeRef: thread.ref,
          ...(lastTurnRef ? { lastTurnRef } : {}),
          ...(thread.statePath ? { statePath: thread.statePath } : {}),
        },
      },
      store,
    });
    expect(problems).toEqual([]);
    expect(completed(second)?.status).toBe("completed");
    // The loaded thread went on: nothing was read back from Work.
    expect(second.calls.some((call) => call.kind === "native_state.load")).toBe(
      false,
    );
    // Its rollout, through the end of the turn, reached Work anyway.
    const stored = JSON.stringify(store.load(thread.ref.id, "rollout"));
    expect(stored).toContain("The number was 7.");
    expect(stored.match(/task_complete/g)?.length).toBe(2);
  } finally {
    await adapter.dispose?.();
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}, 90_000);
