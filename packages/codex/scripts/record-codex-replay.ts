/**
 * Records the Codex replay transcripts (ADR 0197) from the pinned
 * `codex app-server` against a scripted loopback Responses API:
 *
 *   bun run record:codex-replay [scenario...]
 *
 * Each scenario in `src/__tests__/replay/scenarios.ts` runs through the
 * real adapter and the real runner; what crossed the app-server process
 * is written to `fixtures/replay/<scenario>.json`.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordScenario } from "../src/__tests__/replay/record-scenario.js";
import { SCENARIOS } from "../src/__tests__/replay/scenarios.js";
import { pinnedCodexCommand } from "../src/testing/pinned.js";

const output = path.resolve(import.meta.dirname, "../fixtures/replay");
const command = pinnedCodexCommand();
const cliVersion = execFileSync(command, ["--version"], { encoding: "utf8" })
  .trim()
  .replace(/^codex-cli\s+/, "");

const wanted = process.argv.slice(2);
const scenarios = wanted.length
  ? SCENARIOS.filter((scenario) => wanted.includes(scenario.name))
  : SCENARIOS;
if (scenarios.length !== (wanted.length || SCENARIOS.length))
  throw new Error(`Unknown scenario in ${wanted.join(", ")}`);

await mkdir(output, { recursive: true });
const written: string[] = [];
for (const scenario of scenarios) {
  const { transcript, results } = await recordScenario({
    scenario,
    command,
    cliVersion,
  });
  const file = path.join(output, `${scenario.name}.json`);
  await writeFile(file, `${JSON.stringify(transcript, null, 2)}\n`);
  written.push(file);
  const outcomes = results.map(
    (result) =>
      result.events.find((event) => event.type === "turn.completed") ?? null,
  );
  console.log(
    `${scenario.name}: ${transcript.entries.length} entries; ${outcomes
      .map((event) =>
        event && event.type === "turn.completed" ? event.status : "none",
      )
      .join(", ")}`,
  );
}
// Fixtures are checked in formatted like the rest of the repository.
execFileSync("bunx", ["biome", "format", "--write", ...written], {
  stdio: "inherit",
});
