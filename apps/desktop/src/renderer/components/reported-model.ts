/**
 * The model a chat's harness reported as actually serving it, read from the
 * settled turns' usage (ADR 0057).
 */
import type { TimelineTurn } from "@catamorphic/react";

/** Notices after which earlier replies belong to a different model. */
const SELECTION_CHANGES = new Set(["agent_changed", "model_changed"]);

/** Last model id a harness reported as actually serving this conversation. */
export function latestReportedModel(
  turns: readonly TimelineTurn[],
): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const group = turns[index];
    if (!group) continue;
    // Replies preceding a selection change belong to a different model.
    if (
      group.entries.some(
        (entry) =>
          entry.kind === "notice" && SELECTION_CHANGES.has(entry.item.code),
      )
    )
      return null;
    const model = group.turn?.outcome?.usage?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}
