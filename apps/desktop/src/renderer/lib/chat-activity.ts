import type { SessionState } from "@catamorphic/react";
import type { ChatWaiting } from "../../shared/chat.js";

/**
 * What a running turn is only waiting on, when every step it has under way
 * is a wait: its subagents (`wait_for_subsessions`), or a watch or a
 * background command it reads with a wait (`read_background_output`). Its
 * icon then shows that instead of the spinner: the agent is doing nothing
 * but wait. Null while anything else runs (a command, a reply being
 * written, a subagent's steps) or between steps.
 */
export function currentWait(
  state: Pick<SessionState, "items"> | null,
  activeTurnId: string | null,
): ChatWaiting | null {
  if (!state || !activeTurnId) return null;
  let wait: ChatWaiting | null = null;
  for (const item of state.items) {
    if (item.turnId !== activeTurnId || item.status !== "in_progress") continue;
    const kind = item.kind === "tool_call" ? waitOf(item) : null;
    if (!kind) return null;
    wait = kind;
  }
  return wait;
}

function waitOf(call: { tool: string; input: unknown }): ChatWaiting | null {
  const tool = call.tool
    .replace(/^mcp__.+?__/, "")
    .split("/")
    .pop();
  const input = isRecord(call.input) ? call.input : {};
  if (tool === "wait_for_subsessions")
    return input.timeout_ms === 0 ? null : "subagent";
  if (tool !== "read_background_output") return null;
  const waits =
    (typeof input.wait_seconds === "number" && input.wait_seconds > 0) ||
    (typeof input.wait_for === "string" && input.wait_for !== "");
  if (!waits) return null;
  return typeof input.id === "string" && input.id.startsWith("watch-")
    ? "watch"
    : "command";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
