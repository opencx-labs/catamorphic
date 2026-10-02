import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerSpec } from "@catamorphic/agent-protocol/runner";
import {
  type AttemptOutcome,
  driveAttempt,
  type RunnerLike,
  ScriptedNativeState,
} from "./host.js";
import type { ClaudeScenario } from "./scenarios.js";

/** Where a scenario's attempts run: here, and on "another machine". */
export interface ScenarioDirectories {
  here: { cwd: string; state: string; home: string };
  elsewhere: { cwd: string; state: string; home: string };
}

/** The replay tokens for a scenario's directories and model address. */
export function scenarioTokens(input: {
  directories: ScenarioDirectories;
  modelUrl: string;
}): Record<string, string> {
  const { here, elsewhere } = input.directories;
  return {
    cwd: here.cwd,
    state: here.state,
    home: here.home,
    cwd2: elsewhere.cwd,
    state2: elsewhere.state,
    home2: elsewhere.home,
    model: input.modelUrl,
  };
}

/**
 * Run a scenario's attempts in order, each on its own runner, with one
 * host keeping the native thread state between them (as Work does).
 */
export async function runScenario(input: {
  scenario: ClaudeScenario;
  runner: (attempt: number) => RunnerLike;
  directories: ScenarioDirectories;
  modelUrl: string;
  fixtureServer: McpServerSpec;
  timeoutMs?: number;
  /** Told where each attempt runs before it starts (the scripted model reads it). */
  onAttempt?: (input: { index: number; cwd: string }) => void;
}): Promise<AttemptOutcome[]> {
  const nativeState = new ScriptedNativeState();
  const outcomes: AttemptOutcome[] = [];
  for (const place of [input.directories.here, input.directories.elsewhere]) {
    await Promise.all([
      mkdir(place.cwd, { recursive: true }),
      mkdir(place.state, { recursive: true }),
      mkdir(place.home, { recursive: true }),
    ]);
    for (const [name, content] of Object.entries(input.scenario.files ?? {}))
      await writeFile(path.join(place.cwd, name), content);
    // The gateway grant a host writes for the attempt (ADR 0180).
    await writeFile(path.join(place.state, "model-key"), "fixture-key");
  }
  for (const [index, step] of input.scenario.attempts.entries()) {
    const place = step.elsewhere
      ? input.directories.elsewhere
      : input.directories.here;
    input.onAttempt?.({ index, cwd: place.cwd });
    const attempt = step.start({
      ...place,
      modelUrl: input.modelUrl,
      fixtureServer: input.fixtureServer,
      previous: outcomes,
    });
    outcomes.push(
      await driveAttempt({
        runner: input.runner(index),
        attempt,
        host: step.host ?? {},
        nativeState,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      }),
    );
  }
  return outcomes;
}
