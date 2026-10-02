import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { createCodexAdapter } from "../../adapter.js";
import {
  CodexReplay,
  type CodexReplayFixture,
  type CodexTranscript,
  loadCodexFixture,
} from "../../testing/index.js";
import {
  type AttemptResult,
  driveAttempt,
  type HostScript,
  NativeStore,
} from "./driver.js";
import {
  type ScenarioContext,
  scenario,
  WORKSPACE_FILES,
} from "./scenarios.js";

export interface ReplayRun {
  root: string;
  results: AttemptResult[];
  store: NativeStore;
  replay: CodexReplay;
}

/**
 * Replay a recorded scenario through the real adapter and runner, in a
 * fresh temporary root, and verify every outbound frame matched.
 */
export async function replayScenario(
  name: CodexReplayFixture,
  options: {
    /** A transcript to replay instead of the shipped fixture (a derived one). */
    transcript?: CodexTranscript;
    verify?: boolean;
    /** Replaces an attempt's host script, by attempt index. */
    scripts?: Record<number, HostScript>;
  } = {},
): Promise<ReplayRun> {
  const definition = scenario(name);
  const root = await realpath(
    await mkdtemp(path.join(await realpath(tmpdir()), "codex-replay-test-")),
  );
  await mkdir(path.join(root, "work"), { recursive: true });
  for (const [file, text] of Object.entries(WORKSPACE_FILES))
    await writeFile(path.join(root, "work", file), text);
  await writeFile(path.join(root, "model-key"), "fixture-model-key");
  const context: ScenarioContext = {
    root,
    model: "http://127.0.0.1:9/v1",
    node: "/usr/bin/node",
    fixtures: "/fixtures",
    command: "codex",
  };
  const replay = new CodexReplay(
    options.transcript ?? (await loadCodexFixture(name)),
    {
      placeholders: {
        root,
        model: context.model,
        node: context.node,
        fixtures: context.fixtures,
        host: "replay-host",
        tmp: "/tmp",
      },
    },
  );
  const adapter = createCodexAdapter({ transport: replay.transport });
  const store = new NativeStore();
  const results: AttemptResult[] = [];
  for (const [index, attempt] of definition.attempts.entries()) {
    const script = options.scripts?.[index] ?? attempt.script;
    results.push(
      await driveAttempt({
        adapter,
        attempt: attempt.build(context, results),
        store,
        ...(script ? { script } : {}),
        timeoutMs: 20_000,
      }),
    );
  }
  if (options.verify !== false) await replay.verify();
  return { root, results, store, replay };
}

export async function cleanup(run: ReplayRun): Promise<void> {
  await rm(run.root, { recursive: true, force: true });
}

/** The events of one attempt, without diagnostics. */
export function eventsOf(run: ReplayRun, attempt = 0): HarnessEvent[] {
  return (run.results[attempt]?.events ?? []).filter(
    (event) => event.type !== "diagnostic",
  );
}

export function completionOf(
  run: ReplayRun,
  attempt = 0,
): Extract<HarnessEvent, { type: "turn.completed" }> | undefined {
  return eventsOf(run, attempt).find(
    (event): event is Extract<HarnessEvent, { type: "turn.completed" }> =>
      event.type === "turn.completed",
  );
}

/** Concatenated text of an item's deltas and final value. */
export function itemText(events: HarnessEvent[], key: string): string {
  let text = "";
  for (const event of events) {
    if (event.type === "item.started" && event.key === key)
      text = "text" in event.item ? String(event.item.text) : "";
    if (
      event.type === "item.delta" &&
      event.key === key &&
      event.field === "text"
    )
      text += event.text;
  }
  return text;
}
