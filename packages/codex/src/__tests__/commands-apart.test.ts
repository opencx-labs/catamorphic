import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  CODEX_COMMANDS_APART_REFUSAL,
  createCodexAdapter,
} from "../adapter.js";
import { driveAttempt, NativeStore } from "./replay/driver.js";
import { attemptBase } from "./replay/scenarios.js";

/**
 * Codex chooses its own shell (ADR 0332), so where commands run apart from
 * the agent it is refused before it starts, never run beside the agent.
 */
it("refuses an attempt whose commands run apart, without starting Codex", async () => {
  let started = false;
  const adapter = createCodexAdapter({
    transport: () => {
      started = true;
      throw new Error("Codex must not start");
    },
  });
  const root = path.join(os.tmpdir(), "codex-apart");
  const result = await driveAttempt({
    adapter,
    attempt: {
      ...attemptBase(
        {
          root,
          model: "http://127.0.0.1:9",
          node: process.execPath,
          fixtures: root,
          command: "codex",
        },
        { ordinal: 1, text: "Run the tests." },
      ),
      commands: { socket: "/run/work-commands/commands.sock" },
    },
    store: new NativeStore(),
  });
  const completed = result.events.find(
    (event) => event.type === "turn.completed",
  );
  expect(completed).toMatchObject({
    type: "turn.completed",
    status: "failed",
    error: { message: CODEX_COMMANDS_APART_REFUSAL },
  });
  expect(started).toBe(false);
});
