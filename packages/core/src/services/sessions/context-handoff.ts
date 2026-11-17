import {
  type ContextHandoffStrategy,
  type InboundSender,
  type InputItem,
  type Item,
  isInputItem,
} from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import { LATEST_RESULT_VALUE_BYTES, ownFamilies } from "./session-results.js";
import { itemFromRow } from "./session-rows.js";

/** About 16k tokens: enough to carry a conversation, small enough to stay cheap. */
export const HANDOFF_BUDGET_CHARS = 64_000;
const LINE_MAX = 2_000;
/** The commands a turn's summary still names, its last ones. */
const COMMANDS_SHOWN = 3;
/** The share of the budget results and unanswered requests may take. */
const KEPT_SHARE = 0.5;
/** Longest request carried verbatim; a longer one is cut and says so. */
const REQUEST_MAX = 8_000;
/** A result value longer than its compact view shows this much. */
const RESULT_EXCERPT = 2_000;
/** Requests a chat with no result yet carries verbatim, its latest. */
const LATEST_REQUESTS = 3;

export interface ContextHandoff {
  strategy: ContextHandoffStrategy;
  coveredTurnOrdinals: { from: number; to: number };
  fromProviderThreadIds: string[];
  text: string;
}

/**
 * What a provider thread did not see (ADR 0198): the settled turns from
 * `fromOrdinal` through `toOrdinal`, as an auditable, budgeted summary of
 * what was asked, answered, run and changed. Its first request and its most
 * recent turns are kept; whatever does not fit in the middle is named, not
 * carried, and the agent can read it with the session history tool.
 *
 * What must not be summarized rides beside it, verbatim (ADR 0328): the
 * chat's accepted results, the latest of each name, and the requests that
 * arrived after the newest of them. They take at most half the budget, and
 * the summary takes what they leave.
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
      "inbound_message",
      "task_notification",
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
  const total = input.budgetChars ?? HANDOFF_BUDGET_CHARS;
  const kept = await keptSections({
    db: input.db,
    sessionId: input.sessionId,
    ordinals: new Map(turns.map((turn) => [turn.id, turn.ordinal])),
    budget: Math.floor(total * KEPT_SHARE),
  });
  const budget = total - kept.length;
  const recent: string[] = [];
  let used = 0;
  // Newest first, then the very first request if it still fits.
  const newestFirst = sections.slice(1).reverse();
  for (const section of newestFirst) {
    if (used + section.length > budget) break;
    recent.unshift(section);
    used += section.length;
  }
  const first = sections[0] ?? "";
  const omitted = sections.length - 1 - recent.length;
  const body = [
    used + first.length <= budget
      ? first
      : truncate(first, Math.max(0, budget - used)),
    omitted > 0
      ? `(${omitted} turn${omitted === 1 ? "" : "s"} in between are not shown; read them with the session history tool.)`
      : "",
    ...recent,
  ]
    .filter(Boolean)
    .join("\n\n");
  const range =
    turns.length > 1
      ? `turns ${turns[0]?.ordinal} to ${turns.at(-1)?.ordinal}`
      : `turn ${turns[0]?.ordinal}`;
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
        ? `While you were away from this conversation, it continued (${range}). This is what happened, so you can pick up from here:`
        : `This conversation started before you joined it (${range}). This is what happened so far:`,
      body,
      kept,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * The hand-off's verbatim sections (ADR 0328): the chat's accepted results,
 * the latest of each name, newest first, each with the request it answers;
 * then the requests of the covered turns that came after the newest
 * result's request (a chat with no result: its latest few), oldest first,
 * the newest kept when they do not all fit. Within `budget` characters, and
 * each section says what it left out and where to read it.
 */
async function keptSections(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  /** The covered turns' ordinals by id. */
  ordinals: ReadonlyMap<string, number>;
  budget: number;
}): Promise<string> {
  const { db, sessionId, ordinals } = input;
  const results = (
    await db
      .selectFrom("agent_items as item")
      .leftJoin("agent_turns as turn", "turn.id", "item.turn_id")
      .select(["item.payload", "turn.ordinal"])
      .distinctOn(sql`item.payload->>'name'`)
      .where("item.session_id", "=", sessionId)
      .where("item.kind", "=", "result")
      .where((eb) =>
        eb.or([
          eb("turn.status", "is", null),
          eb("turn.status", "<>", "rolled_back"),
        ]),
      )
      .orderBy(sql`item.payload->>'name'`)
      .orderBy("item.position", "desc")
      .execute()
  )
    .flatMap((row) => {
      const item = itemFromRow(row);
      return item.kind === "result" ? [{ item, ordinal: row.ordinal }] : [];
    })
    .sort((a, b) => b.item.position - a.item.position);
  const newest = results[0]?.item;
  const answered = [
    ...new Set(
      results.flatMap(({ item }) => (item.input ? [item.input.itemId] : [])),
    ),
  ];
  const covered = [...ordinals.keys()];
  // Requests as a result's `current` counts them (ADR 0323): a person's
  // message, or words from outside the chat's own family. Task
  // notifications and its subsessions' messages are its own work.
  const own = [
    ...((await ownFamilies(db, [sessionId])).get(sessionId) ?? [sessionId]),
  ];
  const requestRows =
    covered.length > 0
      ? await db
          .selectFrom("agent_items as item")
          .select("item.payload")
          .where("item.session_id", "=", sessionId)
          .where("item.kind", "in", ["user_message", "inbound_message"])
          .where("item.turn_id", "in", covered)
          .where((eb) =>
            eb.or([
              eb("item.author_kind", "is", null),
              eb("item.author_kind", "<>", "agent"),
              eb(sql<string>`item.author_payload->>'sessionId'`, "not in", own),
            ]),
          )
          .$if(newest !== undefined, (query) =>
            query.where(
              "item.position",
              ">",
              String(newest?.input?.position ?? -1),
            ),
          )
          .orderBy("item.position", "desc")
          .$if(newest === undefined, (query) => query.limit(LATEST_REQUESTS))
          .execute()
      : [];
  const answeredRows =
    answered.length > 0
      ? await db
          .selectFrom("agent_items")
          .select("payload")
          .where("session_id", "=", sessionId)
          .where("id", "in", answered)
          .execute()
      : [];
  const inputs = new Map(
    answeredRows
      .map((row) => itemFromRow(row))
      .filter(isInputItem)
      .map((item) => [item.id, item]),
  );
  const requests = requestRows
    .map((row) => itemFromRow(row))
    .filter(isInputItem);

  // What the headings and the notes of what is cut take, first.
  let left =
    input.budget -
    (results.length > 0 ? RESULTS_HEADING.length + NOTE_ALLOWANCE : 0) -
    (requests.length > 0
      ? (newest ? UNANSWERED_HEADING : LATEST_HEADING).length + NOTE_ALLOWANCE
      : 0);
  const resultLines: string[] = [];
  for (const { item, ordinal } of results) {
    const asked = item.input ? inputs.get(item.input.itemId) : undefined;
    const json = JSON.stringify(item.value);
    const value =
      Buffer.byteLength(json, "utf8") > LATEST_RESULT_VALUE_BYTES
        ? `${truncate(json, RESULT_EXCERPT)} (cut here; read the whole value with session_results, result ${item.id})`
        : json;
    const line = [
      `- ${item.name}${ordinal === null ? "" : `, from turn ${ordinal}`}, ${
        asked
          ? `answering ${requestLabel(asked)}${asked.turnId && ordinals.has(asked.turnId) ? ` in turn ${ordinals.get(asked.turnId)}` : ""}: "${truncate(requestText(asked), 200).replace(/\n/g, " ")}"`
          : "answering no request"
      }`,
      `  ${value.replace(/\n/g, "\n  ")}`,
    ].join("\n");
    if (line.length > left) break;
    resultLines.push(line);
    left -= line.length + 1;
  }
  const shownRequests: string[] = [];
  for (const item of requests) {
    const ordinal = item.turnId ? ordinals.get(item.turnId) : undefined;
    const line = `- ${ordinal === undefined ? "" : `Turn ${ordinal}, `}${requestLabel(item)}: ${quoted(requestText(item), REQUEST_MAX)}`;
    if (line.length > left) break;
    shownRequests.unshift(line);
    left -= line.length + 1;
  }
  const sections: string[] = [];
  if (results.length > 0) {
    const cut = results.length - resultLines.length;
    sections.push(
      [
        RESULTS_HEADING,
        ...resultLines,
        ...(cut > 0
          ? [
              `(${cut} more result${cut === 1 ? " is" : "s are"} not shown; read them with session_results.)`,
            ]
          : []),
      ].join("\n"),
    );
  }
  if (requests.length > 0) {
    const cut = requests.length - shownRequests.length;
    sections.push(
      [
        newest ? UNANSWERED_HEADING : LATEST_HEADING,
        ...(cut > 0
          ? [
              `(${cut} earlier request${cut === 1 ? " is" : "s are"} not shown; read ${cut === 1 ? "it" : "them"} with the session history tool.)`,
            ]
          : []),
        ...shownRequests,
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

const RESULTS_HEADING =
  "Your accepted results in this chat, as recorded (submitted with submit_result; the latest of each name, newest first). Do not submit them again unless a request below asks for new work:";
const UNANSWERED_HEADING =
  "Requests that arrived after your newest result, which no result answers yet (verbatim, oldest first):";
const LATEST_HEADING =
  "The latest requests in this chat (verbatim, oldest first):";
/** Room for a section's line saying how much it left out. */
const NOTE_ALLOWANCE = 100;

/** Who made a request, as the hand-off names them. */
function requestLabel(item: InputItem): string {
  switch (item.kind) {
    case "user_message":
      return "Person";
    case "inbound_message":
      return senderLabel(item.from);
    case "task_notification":
      return `Notification (${item.task.type} ${item.task.id})`;
  }
}

function requestText(item: InputItem): string {
  return item.kind === "task_notification" ? item.summary : item.text;
}

/**
 * One turn as the handoff tells it: what was said, in order, and what the
 * agent ran and changed. A turn's commands are counted with only its last
 * few named (a long turn runs hundreds, which tell the next agent little and
 * crowd out what was said), and each changed file is named once.
 */
export function renderTurn(ordinal: number, items: readonly Item[]): string {
  const lines: string[] = [];
  const commands = items.filter((item) => item.kind === "command");
  const shown = new Set(commands.slice(-COMMANDS_SHOWN));
  const changed = new Set<string>();
  for (const item of items) {
    switch (item.kind) {
      case "user_message":
        lines.push(`Person: ${quoted(item.text, LINE_MAX)}`);
        break;
      case "inbound_message":
        lines.push(`${senderLabel(item.from)}: ${quoted(item.text, LINE_MAX)}`);
        break;
      case "task_notification":
        lines.push(
          `Notification (${item.task.type} ${item.task.id}): ${quoted(item.summary, 400)}`,
        );
        break;
      case "assistant_message":
        if (item.status === "completed" && item.text.trim())
          lines.push(`Agent: ${quoted(item.text, LINE_MAX)}`);
        break;
      case "command":
        if (!shown.has(item)) break;
        if (item === commands.at(-shown.size) && commands.length > shown.size)
          lines.push(
            `- ran ${commands.length} commands; the last ${shown.size}:`,
          );
        lines.push(
          `- ran \`${truncate(item.command, 300)}\`${item.exitCode === null ? "" : ` (exit ${item.exitCode})`}`,
        );
        break;
      case "file_change":
        if (changed.has(item.path)) break;
        changed.add(item.path);
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

/** Who sent an inbound message, as the handoff names them. */
function senderLabel(from: InboundSender): string {
  switch (from.kind) {
    case "agent":
      return `Agent in session ${from.sessionId}`;
    case "assistant":
      return "The person's assistant";
    case "workflow":
      return `Workflow ${from.workflowName}`;
  }
}

/**
 * Someone's words in the handoff, their later lines indented: text inside
 * a message can never start a line of its own ("Person: …").
 */
function quoted(value: string, max: number): string {
  return truncate(value, max).replace(/\n/g, "\n  ");
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+\n/g, "\n").trim();
  if (text.length <= max) return text;
  const cut = Math.max(0, max - 1);
  // Never end on the first half of a surrogate pair.
  const code = text.charCodeAt(cut - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
  return `${text.slice(0, end)}…`;
}
