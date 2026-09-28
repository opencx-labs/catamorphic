import type { StartSessionOpts } from "./types.js";

/**
 * Earlier turns for a sandbox-resident session that continues in a new
 * sandbox (after moving Environments, idle release, or a rebuild): the
 * harness's own transcript stayed in the old sandbox, so its instructions
 * carry the host's instead.
 */
export function transcriptHistoryPreamble(
  history: StartSessionOpts["history"],
): string {
  if (!history || history.length === 0) return "";
  const turns = history
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "You"}: ${turn.content.slice(0, 4000)}`,
    )
    .join("\n\n");
  return `This conversation continues from earlier turns, which you no longer hold in your transcript:\n\n${turns.slice(-60_000)}`;
}
