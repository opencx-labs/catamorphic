import {
  renderTurnContext,
  type TurnContextFragment,
} from "@catamorphic/sandbox";
import type { ModelMessage } from "ai";

/**
 * A turn's context (ADR 0152) as a system message placed just before the
 * user's message: kept apart from their words and from the cached
 * instructions, and kept in history like other harnesses' transcripts.
 */
export function turnContextMessages(
  context: readonly TurnContextFragment[] | undefined,
): ModelMessage[] {
  const text = renderTurnContext(context);
  return text ? [{ role: "system", content: text }] : [];
}
