import { execFileSync } from "node:child_process";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { expect, it } from "vitest";
import { pinnedCodexCommand } from "../testing/pinned.js";
import { cleanup, eventsOf, replayScenario } from "./replay/harness.js";
import { recordScenario } from "./replay/record-scenario.js";
import { scenario } from "./replay/scenarios.js";

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

it.each(["simple-reply", "host-and-mcp-tools"] as const)(
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
