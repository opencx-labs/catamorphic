/**
 * Replay testing for the Codex adapter (ADR 0198): recorded app-server
 * transcripts, a replay peer that stands in for the process, and the
 * recorder that made them. Core's integration tests build the adapter
 * with a replay transport and drive it through the real runner:
 *
 * ```ts
 * const replay = new CodexReplay(await loadCodexFixture("simple-reply"), {
 *   placeholders: { root },
 * });
 * const adapter = createCodexAdapter({ transport: replay.transport });
 * // ...run attempts whose fields match the scenario...
 * await replay.verify();
 * ```
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CodexTranscript, readTranscript } from "./transcript.js";

export { pinnedCodexCommand } from "./pinned.js";
export { CodexRecorder } from "./record.js";
export { CodexReplay, type CodexReplayOptions } from "./replay.js";
export {
  abstractTranscript,
  type CodexTranscript,
  type CodexTranscriptEntry,
  materializeTranscript,
  readTranscript,
  type TranscriptPlaceholders,
} from "./transcript.js";

/** The recorded scenarios shipped with this package. */
export const CODEX_REPLAY_FIXTURES = [
  "simple-reply",
  "multi-turn-resume",
  "command-approved",
  "command-denied",
  "file-change",
  "host-and-mcp-tools",
  "user-question",
  "steer-mid-turn",
  "interrupt-mid-turn",
  "error-auth",
  "error-rate-limit",
  "restore-rollout",
  "fork-through-turn",
] as const;

export type CodexReplayFixture = (typeof CODEX_REPLAY_FIXTURES)[number];

/** Where a shipped transcript lives. */
export function codexFixturePath(name: CodexReplayFixture): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../fixtures/replay",
    `${name}.json`,
  );
}

export function loadCodexFixture(
  name: CodexReplayFixture,
): Promise<CodexTranscript> {
  return readTranscript(codexFixturePath(name));
}
