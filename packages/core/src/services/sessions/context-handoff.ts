import type { ContextHandoffStrategy, Item } from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import type { Kysely, Transaction } from "kysely";
import { itemFromRow } from "./session-rows.js";

/** About 16k tokens: enough to carry a conversation, small enough to stay cheap. */
export const HANDOFF_BUDGET_CHARS = 64_000;
const LINE_MAX = 2_000;

export interface ContextHandoff {
  strategy: ContextHandoffStrategy;
  coveredTurnOrdinals: { from: number; to: number };
  fromProviderThreadIds: string[];
  text: string;
}

/**
 * What a provider thread did not see (ADR 0197): the settled turns from
 * `fromOrdinal` through `toOrdinal`, as an auditable, budgeted summary of
 * what was asked, answered, run and changed. Its first request and its most
 * recent turns are kept; whatever does not fit in the middle is named, not
 * carried, and the agent can read it with the session history tool.
 */
export async function buildContextHandoff(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  fromOrdinal: number;
  toOrdinal: number;
  strategy: ContextHandoffStrategy;
  budgetChars?: number;
}): Promise<ContextHandoff | null> {
  if (input.toOrdinal < input.fromOrdinal) return null;
  const turns = await input.db
    .selectFrom("agent_turns")
    .select(["id", "ordinal", "provider_thread_id", "status"])
    .where("session_id", "=", input.sessionId)
    .where("ordinal", ">=", input.fromOrdinal)
    .where("ordinal", "<=", input.toOrdinal)
    .where("status", "not in", ["cancelled", "rolled_back", "queued", "held"])
    .orderBy("ordinal")
    .execute();
  if (turns.length === 0) return null;
  const rows = await input.db
    .selectFrom("agent_items")
    .select("payload")
    .where("session_id", "=", input.sessionId)
    .where(
      "turn_id",
      "in",
      turns.map((turn) => turn.id),
    )
    .where("kind", "in", [
      "user_message",
      "assistant_message",
      "command",
      "file_change",
      "notice",
    ])
    .orderBy("position")
    .execute();
  const byTurn = new Map<string, Item[]>();
  for (const row of rows) {
    const item = itemFromRow(row);
    if (!item.turnId) continue;
    const list = byTurn.get(item.turnId) ?? [];
    list.push(item);
    byTurn.set(item.turnId, list);
  }
  const sections = turns.map((turn) =>
    renderTurn(turn.ordinal, byTurn.get(turn.id) ?? []),
  );
  const budget = input.budgetChars ?? HANDOFF_BUDGET_CHARS;
  const kept: string[] = [];
  let used = 0;
  // Newest first, then the very first request if it still fits.
  const newestFirst = sections.slice(1).reverse();
  for (const section of newestFirst) {
    if (used + section.length > budget) break;
    kept.unshift(section);
    used += section.length;
  }
  const first = sections[0] ?? "";
  const omitted = sections.length - 1 - kept.length;
  const body = [
    used + first.length <= budget ? first : truncate(first, Math.max(0, budget - used)),
    omitted > 0
      ? `(${omitted} turn${omitted === 1 ? "" : "s"} in between are not shown; read them with the session history tool.)`
      : "",
    ...kept,
  ]
    .filter(Boolean)
    .join("\n\n");
  const range = `${turns[0]?.ordinal}${turns.length > 1 ? ` to ${turns.at(-1)?.ordinal}` : ""}`;
  return {
    strategy: input.strategy,
    coveredTurnOrdinals: {
      from: turns[0]?.ordinal ?? input.fromOrdinal,
      to: turns.at(-1)?.ordinal ?? input.toOrdinal,
    },
    fromProviderThreadIds: [
      ...new Set(
        turns
          .map((turn) => turn.provider_thread_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ],
    text: [
      input.strategy === "delta"
        ? `While you were away from this conversation, it continued (turns ${range}). This is what happened, so you can pick up from here:`
        : `This conversation started before you joined it (turns ${range}). This is what happened so far:`,
      body,
    ].join("\n\n"),
  };
}

function renderTurn(ordinal: number, items: readonly Item[]): string {
  const lines: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "user_message":
        lines.push(`Person: ${truncate(item.text, LINE_MAX)}`);
        break;
      case "assistant_message":
        if (item.status === "completed" && item.text.trim())
          lines.push(`Agent: ${truncate(item.text, LINE_MAX)}`);
        break;
      case "command":
        lines.push(
          `- ran \`${truncate(item.command, 300)}\`${item.exitCode === null ? "" : ` (exit ${item.exitCode})`}`,
        );
        break;
      case "file_change":
        lines.push(`- changed ${item.path}`);
        break;
      case "notice":
        lines.push(`(${truncate(item.text, 400)})`);
        break;
      default:
        break;
    }
  }
  return [`Turn ${ordinal}`, ...lines].join("\n");
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+\n/g, "\n").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
