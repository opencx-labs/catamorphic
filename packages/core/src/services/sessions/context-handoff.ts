import {
  type ContextHandoffStrategy,
  type InboundSender,
  type InputItem,
  type Item,
  isInputItem,
} from "@catamorphic/agent-protocol";
import type { DB, Json } from "@catamorphic/db";
import { type Kysely, sql, type Transaction } from "kysely";
import {
  LATEST_RESULT_VALUE_BYTES,
  newestResultIds,
  ownFamilies,
  readRequests,
} from "./session-results.js";
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
  /**
   * The turn the hand-off is for: results an earlier attempt of it
   * submitted are shown apart, and its own request among the open ones.
   */
  currentTurn?: { id: string; ordinal: number };
}): Promise<ContextHandoff | null> {
  if (input.toOrdinal < input.fromOrdinal)
    return input.currentTurn
      ? earlierAttemptHandoff({
          db: input.db,
          sessionId: input.sessionId,
          current: input.currentTurn,
          strategy: input.strategy,
          budget: Math.floor(
            (input.budgetChars ?? HANDOFF_BUDGET_CHARS) * KEPT_SHARE,
          ),
        })
      : null;
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
    ...(input.currentTurn ? { current: input.currentTurn } : {}),
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
 * A turn with no turn before it, started again on a new thread (its first
 * turn's earlier attempt lost its sandbox): what that attempt submitted,
 * so the new thread does not start it over blind. None when it submitted
 * nothing.
 */
async function earlierAttemptHandoff(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  current: { id: string; ordinal: number };
  strategy: ContextHandoffStrategy;
  budget: number;
}): Promise<ContextHandoff | null> {
  const submitted = await input.db
    .selectFrom("agent_items")
    .select("id")
    .where("session_id", "=", input.sessionId)
    .where("turn_id", "=", input.current.id)
    .where("kind", "=", "result")
    .where("status", "=", "completed")
    .limit(1)
    .executeTakeFirst();
  if (!submitted) return null;
  const kept = await keptSections({
    db: input.db,
    sessionId: input.sessionId,
    ordinals: new Map(),
    current: input.current,
    budget: input.budget,
  });
  return {
    strategy: input.strategy,
    coveredTurnOrdinals: {
      from: input.current.ordinal,
      to: input.current.ordinal,
    },
    fromProviderThreadIds: [],
    text: [
      `This turn (turn ${input.current.ordinal}) was started before, and that attempt did not finish. What it submitted is kept:`,
      kept,
    ].join("\n\n"),
  };
}

/**
 * The hand-off's verbatim sections (ADR 0328): the chat's accepted results,
 * the latest of each name, newest first, each with the request it answers
 * and whether a newer request arrived since; results an earlier attempt of
 * the turn being handed off submitted, apart, since that turn is still open;
 * then the requests after the newest settled result's request (a chat with
 * no result: its latest few), this turn's own last, oldest first. Within
 * `budget` characters: the newest request always, then results (cut to an
 * excerpt when space is short), then earlier requests; each section says
 * what it left out and where to read it.
 */
async function keptSections(input: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
  /** The covered turns' ordinals by id. */
  ordinals: ReadonlyMap<string, number>;
  /** The turn the hand-off is for, when it may have run attempts already. */
  current?: { id: string; ordinal: number };
  budget: number;
}): Promise<string> {
  const { db, sessionId, ordinals, current } = input;
  /** The latest result of each name, of the turns before the current one. */
  const latestSettled = async () =>
    (
      await db
        .selectFrom("agent_items as item")
        .leftJoin("agent_turns as turn", "turn.id", "item.turn_id")
        .select(["item.payload", "turn.ordinal"])
        .distinctOn(sql`item.payload->>'name'`)
        .where("item.session_id", "=", sessionId)
        // Among the chat's newest results, through their index (ADR 0336).
        .where("item.id", "in", newestResultIds(db, sessionId))
        .where("item.kind", "=", "result")
        // A result this side did not accept (a mirror's) is no result.
        .where("item.status", "=", "completed")
        .where((eb) =>
          eb.or([
            eb("turn.status", "is", null),
            eb("turn.status", "<>", "rolled_back"),
          ]),
        )
        .$if(current !== undefined, (query) =>
          query.where((eb) =>
            eb.or([
              eb("item.turn_id", "is", null),
              eb("item.turn_id", "<>", current?.id ?? ""),
            ]),
          ),
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
  // Submitted by an earlier attempt of the turn being handed off: that
  // turn is still open, so they answer nothing settled. Every one, newest
  // first, not only each name's latest (ADR 0336): a restarted attempt
  // sees each finding it already submitted, by id, and does not submit it
  // again under another.
  // Each in short: its name and short fields (an id, a title), never its
  // whole value, so every one fits and none loads a large value.
  const earlier = current
    ? await db
        .selectFrom("agent_items as item")
        .select([
          "item.id",
          sql<string>`item.payload->>'name'`.as("name"),
          sql<Json>`CASE jsonb_typeof(item.payload->'value')
            WHEN 'object' THEN COALESCE((
              SELECT jsonb_object_agg(field.key, field.value)
                FROM jsonb_each(item.payload->'value') AS field
               WHERE jsonb_typeof(field.value) IN ('number', 'boolean')
                  OR (jsonb_typeof(field.value) = 'string'
                      AND length(field.value #>> '{}') <= ${SHORT_FIELD})), '{}'::jsonb)
            WHEN 'string' THEN CASE WHEN length(item.payload->>'value') <= ${SHORT_FIELD}
              THEN item.payload->'value' END
            WHEN 'array' THEN NULL
            ELSE item.payload->'value' END`.as("short"),
        ])
        .where("item.session_id", "=", sessionId)
        .where("item.turn_id", "=", current.id)
        .where("item.kind", "=", "result")
        .where("item.status", "=", "completed")
        .orderBy("item.position", "desc")
        .limit(EARLIER_RESULTS)
        .execute()
    : [];
  const settled = await latestSettled();
  const results = settled;
  const newest = settled[0]?.item;
  const answered = [
    ...new Set(
      results.flatMap(({ item }) => (item.input ? [item.input.itemId] : [])),
    ),
  ];
  const turnIds = [...ordinals.keys(), ...(current ? [current.id] : [])];
  // Requests as a result's `current` counts them (ADR 0323): a person's
  // message, or words from outside the chat's own family. Task
  // notifications and its subsessions' messages are its own work.
  const own = [
    ...((await ownFamilies(db, [sessionId])).get(sessionId) ?? [sessionId]),
  ];
  const requestRows =
    turnIds.length > 0
      ? await readRequests(db, {
          sessionId,
          own,
          turnIds,
          ...(newest !== undefined
            ? { after: newest.input?.position ?? -1 }
            : { limit: LATEST_REQUESTS }),
        })
      : [];
  // The chat's newest request: a result whose request is older is stale.
  const [newestRequest] = await readRequests(db, {
    sessionId,
    own,
    limit: 1,
  });
  const newestRequestAt =
    newestRequest === undefined ? undefined : Number(newestRequest.position);
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
  /** Newest first. */
  const requests = requestRows
    .map((row) => itemFromRow(row))
    .filter(isInputItem);
  const turnLabel = (turnId: string | null) =>
    turnId && current && turnId === current.id
      ? `turn ${current.ordinal} (this turn)`
      : turnId && ordinals.has(turnId)
        ? `turn ${ordinals.get(turnId)}`
        : undefined;
  const requestLine = (item: InputItem, max: number) => {
    const turn = turnLabel(item.turnId);
    const head = `- ${turn ? `${turn[0]?.toUpperCase()}${turn.slice(1)}, ` : ""}${requestLabel(item)}: `;
    return `${head}${quoted(requestText(item), Math.max(1, max - head.length))}`;
  };
  const resultLine = (
    { item, ordinal }: (typeof results)[number],
    room: number,
  ): string | undefined => {
    const asked = item.input ? inputs.get(item.input.itemId) : undefined;
    const askedTurn = asked ? turnLabel(asked.turnId) : undefined;
    const standing =
      current !== undefined && item.turnId === current.id
        ? ""
        : newestRequestAt !== undefined &&
            (item.input === null || item.input.position < newestRequestAt)
          ? "; a newer request has arrived since"
          : "; it answers the newest request";
    const head = `- ${item.name}${ordinal === null ? "" : `, from turn ${ordinal}`}, ${
      asked
        ? `answering ${requestLabel(asked)}${askedTurn ? ` in ${askedTurn}` : ""}: "${truncate(requestText(asked), 200).replace(/\n/g, " ")}"`
        : "answering no request"
    }${standing}\n  `;
    const json = JSON.stringify(item.value);
    const pointer = ` (cut here; read the whole value with session_results, result ${item.id})`;
    const whole =
      Buffer.byteLength(json, "utf8") <= LATEST_RESULT_VALUE_BYTES &&
      head.length + json.length <= room;
    if (whole) return `${head}${json}`;
    // An excerpt, when the value is large or space is short.
    const excerpt = Math.min(
      RESULT_EXCERPT,
      room - head.length - pointer.length,
    );
    if (excerpt < MIN_EXCERPT) return undefined;
    return `${head}${truncate(json, excerpt)}${pointer}`;
  };

  // What the headings and the notes of what is cut take, first.
  const earlierLines = earlier.map(
    (row) =>
      `- ${row.name}: ${
        row.short === null
          ? `(read it with session_results, result ${row.id})`
          : truncate(JSON.stringify(row.short), SHORT_LINE)
      }`,
  );
  let left =
    input.budget -
    (settled.length > 0 ? RESULTS_HEADING.length + NOTE_ALLOWANCE : 0) -
    (earlier.length > 0
      ? EARLIER_HEADING.length +
        earlierLines.reduce((sum, line) => sum + line.length + 1, 0)
      : 0) -
    (requests.length > 0
      ? (newest ? UNANSWERED_HEADING : LATEST_HEADING).length + NOTE_ALLOWANCE
      : 0);
  // The newest request always: it is what the agent must act on.
  const shownRequests: string[] = [];
  const [latest, ...older] = requests;
  if (latest) {
    const line = requestLine(
      latest,
      Math.min(REQUEST_MAX, Math.max(MIN_EXCERPT, Math.floor(left / 2))),
    );
    shownRequests.push(line);
    left -= line.length + 1;
  }
  const fill = (list: typeof results): string[] => {
    const lines: string[] = [];
    for (const entry of list) {
      const line = resultLine(entry, left);
      if (line === undefined) break;
      lines.push(line);
      left -= line.length + 1;
    }
    return lines;
  };
  const settledLines = fill(settled);
  for (const item of older) {
    const line = requestLine(item, REQUEST_MAX);
    if (line.length > left) break;
    shownRequests.unshift(line);
    left -= line.length + 1;
  }
  const resultsCut = (cut: number) =>
    cut > 0
      ? [
          `(${cut} more result${cut === 1 ? " is" : "s are"} not shown; read ${cut === 1 ? "it" : "them"} with session_results.)`,
        ]
      : [];
  const sections: string[] = [];
  if (earlier.length > 0)
    sections.push([EARLIER_HEADING, ...earlierLines].join("\n"));
  if (settled.length > 0)
    sections.push(
      [
        RESULTS_HEADING,
        ...settledLines,
        ...resultsCut(settled.length - settledLines.length),
      ].join("\n"),
    );
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

/** Results of the turn being handed off it lists, newest first: all of them. */
const EARLIER_RESULTS = 100;
/** The longest field an earlier result shows in short, and its line. */
const SHORT_FIELD = 200;
const SHORT_LINE = 300;
const EARLIER_HEADING =
  "Submitted by an earlier attempt of this turn, which did not finish (this turn's request is still open; submit again if they are still right). Each in short, newest first, with its short fields; read whole values with session_results:";
const RESULTS_HEADING =
  "Your accepted results in this chat, as recorded (submitted with submit_result; the latest of each name, newest first). Each says whether a newer request arrived since; a request below may need a new one:";
const UNANSWERED_HEADING =
  "Requests that arrived after your newest result, which no result answers yet (verbatim, oldest first):";
const LATEST_HEADING =
  "The latest requests in this chat (verbatim, oldest first):";
/** Room for a section's line saying how much it left out. */
const NOTE_ALLOWANCE = 100;
/** The shortest excerpt worth showing of a value or a request. */
const MIN_EXCERPT = 200;

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
