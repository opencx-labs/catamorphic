/**
 * Replaying recorded Claude Code transcripts (ADR 0198): fixtures from the
 * real pinned CLI, a `query` that replays them into the real adapter, and
 * a scripted host to drive a runner with. Core's integration tests use
 * `replayQuery` with `createClaudeCodeAdapter({ query })` to run the turn
 * driver, log and projections over real Claude Code output.
 */
export {
  type ClaudeOutbound,
  type ClaudeReplayAttempt,
  type ClaudeReplayTranscript,
  detokenize,
  isReplayCallback,
  outboundOf,
  type ReplayCallback,
  type ReplayEntry,
  type ReplayTokens,
  tokenize,
} from "./format.js";
export {
  type AttemptOutcome,
  driveAttempt,
  type HostControl,
  type RunnerLike,
  type ScriptedHostBehavior,
  ScriptedNativeState,
} from "./host.js";
export { pinnedClaudeExecutable } from "./pinned-cli.js";
export { recordingQuery } from "./record.js";
export {
  fixturePath,
  loadClaudeTranscript,
  ReplayDivergenceError,
  type ReplayOptions,
  replayQuery,
} from "./replay.js";
export {
  runScenario,
  type ScenarioDirectories,
  scenarioTokens,
} from "./run.js";
export {
  CLAUDE_SCENARIOS,
  type ClaudeScenario,
  eventsOf,
  itemsOf,
  SCENARIO_MODEL,
  type ScenarioAttempt,
  type ScenarioContext,
  scenarioAttempt,
  stableUuid,
} from "./scenarios.js";
export {
  type ScriptedBlock,
  type ScriptedModel,
  type ScriptedReply,
  type ScriptedRequest,
  scriptedModelEnv,
  startScriptedModel,
} from "./scripted-model.js";

/** Where the stdio MCP server the tool-policy scenarios connect lives. */
export const FIXTURE_MCP_SERVER = new URL(
  "../../src/testing/fixture-mcp-server.ts",
  import.meta.url,
).pathname;
