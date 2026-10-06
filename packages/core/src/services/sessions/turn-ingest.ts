import { createHash } from "node:crypto";
import type {
  AgentTurnUsage,
  Attempt,
  Item,
  ItemPayload,
  JsonValue,
  NativeRef,
  ProviderThread,
  RuntimeRequest,
  SessionEvent,
  Turn,
  TurnError,
} from "@catamorphic/agent-protocol";
import { itemActivity } from "@catamorphic/agent-protocol";
import type {
  HarnessEvent,
  ItemDraft,
} from "@catamorphic/agent-protocol/runner";
import type { DB } from "@catamorphic/db";
import type { Transaction } from "kysely";
import type { SecretMaskBatch, StreamKey } from "./secret-mask.js";
import { itemFromRow, requestFromRow } from "./session-rows.js";

/** A stable id derived from an attempt and an adapter's key. */
export function derivedId(attemptId: string, key: string): string {
  const hex = createHash("sha256")
    .update(`${attemptId}\u0000${key}`)
    .digest("hex");
  // Version 8 (custom) UUID layout, so the value is a valid uuid column.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export interface IngestState {
  sessionId: string;
  turn: Turn;
  attempt: Attempt;
  thread: ProviderThread;
  agentId: string | null;
}

/** What one batch of harness events changed, beyond its session events. */
export interface IngestResult {
  events: SessionEvent[];
  turn: Turn;
  attempt: Attempt;
  thread: ProviderThread;
  /** The harness finished its turn in this batch. */
  completed?: {
    status: "completed" | "failed" | "interrupted";
    error?: TurnError;
    ref?: NativeRef;
  };
  usage?: AgentTurnUsage;
  title?: string;
  statePath?: string;
  /** Steered inputs the harness took into its context in this batch. */
  consumed: string[];
}

/** Live lines are bounded; long tool output is cut by the runner already. */
const STATUS_MAX = 200;

/** The fields a harness streams into. */
const STREAMED_FIELDS = ["text", "output"] as const;

/**
 * Turn one batch of an attempt's harness events into session events
 * (ADR 0197). Item and request ids derive from the attempt and the
 * adapter's keys, so ingesting a frame twice (a replica took over and read
 * from its cursor again) changes nothing: an item that exists is merged,
 * never duplicated. Deltas of one item in a batch arrive as one append.
 * With `mask`, the values the turn's sandbox received are replaced in
 * everything recorded (ADR 0206).
 */
export async function ingestHarnessEvents(input: {
  trx: Transaction<DB>;
  state: IngestState;
  events: readonly HarnessEvent[];
  now: Date;
  mask?: SecretMaskBatch;
}): Promise<IngestResult> {
  const { trx, state, mask } = input;
  const at = input.now.toISOString();
  const attemptId = state.attempt.id;
  const out: SessionEvent[] = [];
  let turn = state.turn;
  let attempt = state.attempt;
  let thread = state.thread;
  const result: Omit<IngestResult, "events" | "turn" | "attempt" | "thread"> = {
    consumed: [],
  };

  // Load what this batch touches: items and requests by their derived ids.
  const itemIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const event of input.events) {
    if ("key" in event && typeof event.key === "string") {
      if (event.type === "request.opened" || event.type === "request.closed")
        requestIds.add(derivedId(attemptId, `request:${event.key}`));
      else itemIds.add(derivedId(attemptId, event.key));
    }
  }
  const items = new Map<string, Item>();
  if (itemIds.size > 0) {
    const rows = await trx
      .selectFrom("agent_items")
      .select("payload")
      .where("id", "in", [...itemIds])
      .execute();
    for (const row of rows) {
      const item = itemFromRow(row);
      items.set(item.id, item);
    }
  }
  const requests = new Map<string, RuntimeRequest>();
  if (requestIds.size > 0) {
    const rows = await trx
      .selectFrom("agent_runtime_requests")
      .selectAll()
      .where("session_id", "=", state.sessionId)
      .where("request_id", "in", [...requestIds])
      .execute();
    for (const row of rows) requests.set(row.request_id, requestFromRow(row));
  }

  // Coalesced streamed text: item id and field → appended text.
  let pendingDelta:
    | { itemId: string; field: "text" | "output"; text: string }
    | undefined;
  const flushDelta = () => {
    if (!pendingDelta) return;
    out.push({
      type: "item.text_appended",
      itemId: pendingDelta.itemId,
      field: pendingDelta.field,
      text: pendingDelta.text,
      at,
    });
    const item = items.get(pendingDelta.itemId);
    if (item) items.set(item.id, appendLocal(item, pendingDelta, at));
    pendingDelta = undefined;
  };
  // Text a mask held back, recorded once its item ends.
  const release = (key: StreamKey) => {
    const rest = mask?.flush(key);
    if (!rest || !items.has(key.itemId)) return;
    pendingDelta = { ...key, text: rest };
    flushDelta();
  };
  // The agent's own status line wins over one derived from its work.
  let status: string | undefined;
  let derived: string | undefined;

  const emitTurn = (next: Turn) => {
    turn = { ...next, updatedAt: at };
    out.push({ type: "turn.changed", turn });
  };

  for (const event of input.events) {
    if (event.type !== "item.delta") flushDelta();
    switch (event.type) {
      case "thread": {
        thread = {
          ...thread,
          nativeRef: event.ref,
          status: "active",
          updatedAt: at,
        };
        out.push({ type: "provider_thread.changed", thread });
        if (event.statePath) result.statePath = event.statePath;
        break;
      }
      case "turn.started": {
        if (event.ref) {
          attempt = { ...attempt, nativeTurnRef: event.ref };
          out.push({ type: "attempt.changed", attempt });
        }
        break;
      }
      case "item.started": {
        const id = derivedId(attemptId, event.key);
        // A harness reports its own work; people's messages, notices,
        // handoffs and requests are Work's to write.
        if (items.has(id) || !HARNESS_ITEM_KINDS.has(event.item.kind)) break;
        const item = newItem({
          id,
          draft: mask ? mask.value(event.item) : event.item,
          state: { ...state, turn, attempt },
          parentItemId: event.item.parentKey
            ? derivedId(attemptId, event.item.parentKey)
            : null,
          nativeRef: event.ref ?? null,
          status: event.status ?? "in_progress",
          at,
        });
        items.set(id, item);
        out.push({ type: "item.added", item });
        derived = itemActivity(item) ?? derived;
        break;
      }
      case "item.delta": {
        const id = derivedId(attemptId, event.key);
        if (!items.has(id)) break;
        const text = mask
          ? mask.stream({ itemId: id, field: event.field }, event.text)
          : event.text;
        if (text.length === 0) break;
        if (
          pendingDelta &&
          (pendingDelta.itemId !== id || pendingDelta.field !== event.field)
        )
          flushDelta();
        pendingDelta = pendingDelta
          ? { ...pendingDelta, text: pendingDelta.text + text }
          : { itemId: id, field: event.field, text };
        break;
      }
      case "item.updated":
      case "item.completed": {
        const id = derivedId(attemptId, event.key);
        if (!items.has(id)) break;
        const changes = mask ? mask.value(event.item) : event.item;
        // A field given whole replaces what streamed into it; an item that
        // ends records what its stream still held.
        for (const field of STREAMED_FIELDS) {
          if (changes && field in changes) mask?.drop({ itemId: id, field });
          else if (event.type === "item.completed")
            release({ itemId: id, field });
        }
        const current = items.get(id);
        if (!current) break;
        // A harness changes an item's content, never what Work owns of it.
        const content: Record<string, unknown> = { ...changes };
        for (const field of WORK_OWNED_ITEM_FIELDS) delete content[field];
        const merged = {
          ...current,
          ...content,
          ...(event.type === "item.completed"
            ? { status: event.status, endedAt: at }
            : {}),
          updatedAt: at,
        } as Item;
        items.set(id, merged);
        out.push({ type: "item.changed", item: merged });
        break;
      }
      case "request.opened": {
        const id = derivedId(attemptId, `request:${event.key}`);
        if (requests.has(id)) break;
        const itemId = derivedId(attemptId, `request-item:${event.key}`);
        const opened = mask ? mask.value(event.request) : event.request;
        const request: RuntimeRequest = {
          id,
          sessionId: state.sessionId,
          turnId: turn.id,
          attemptId,
          itemId,
          kind: opened.kind,
          status: "pending",
          answerable: true,
          blocking: opened.blocking,
          title: opened.title,
          description: opened.description ?? null,
          origin: opened.origin,
          questions: opened.questions ?? null,
          approval: opened.approval ?? null,
          elicitation: opened.elicitation ?? null,
          approvers: [],
          expiresAt: null,
          response: null,
          resolvedBy: null,
          reason: null,
          createdAt: at,
          resolvedAt: null,
          runnerKey: event.key,
        };
        requests.set(id, request);
        out.push({ type: "request.changed", request });
        const item = newItem({
          id: itemId,
          draft: { kind: "request", requestId: id },
          state: { ...state, turn, attempt },
          parentItemId: null,
          nativeRef: null,
          status: "in_progress",
          at,
        });
        items.set(itemId, item);
        out.push({ type: "item.added", item });
        if (event.request.blocking && turn.status === "running")
          emitTurn({
            ...turn,
            status: "waiting",
            activity: waitingLine(event.request.kind),
            activityAt: at,
          });
        break;
      }
      case "request.closed": {
        const id = derivedId(attemptId, `request:${event.key}`);
        const current = requests.get(id);
        if (current?.status !== "pending") break;
        const closed: RuntimeRequest = {
          ...current,
          status: "cancelled",
          answerable: false,
          reason: mask ? mask.text(event.reason) : event.reason,
          resolvedAt: at,
        };
        requests.set(id, closed);
        out.push({ type: "request.changed", request: closed });
        break;
      }
      case "status":
        status = (mask ? mask.text(event.text) : event.text)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, STATUS_MAX);
        break;
      case "title":
        result.title = (mask ? mask.text(event.text) : event.text)
          .trim()
          .slice(0, 500);
        break;
      case "usage":
        result.usage = event.usage;
        break;
      case "input.consumed":
        result.consumed.push(...event.itemIds);
        break;
      case "diagnostic":
        break;
      case "turn.completed":
        // Whatever a mask still held is the end of its stream.
        for (const key of mask?.holding() ?? []) release(key);
        result.completed = {
          status: event.status,
          ...(event.error
            ? { error: mask ? mask.value(event.error) : event.error }
            : {}),
          ...(event.ref ? { ref: event.ref } : {}),
        };
        break;
    }
  }
  flushDelta();
  const stillWaiting = [...requests.values()].some(
    (request) => request.status === "pending" && request.blocking,
  );
  if (turn.status === "waiting" && !stillWaiting) {
    const open = await trx
      .selectFrom("agent_runtime_requests")
      .select("request_id")
      .where("session_id", "=", state.sessionId)
      .where("turn_id", "=", turn.id)
      .where("status", "=", "pending")
      .where("blocking", "=", true)
      // This batch's own requests are known above, closed ones included.
      .$if(requests.size > 0, (query) =>
        query.where("request_id", "not in", [...requests.keys()]),
      )
      .executeTakeFirst();
    if (!open) emitTurn({ ...turn, status: "running" });
  }
  const line = status ?? derived;
  if (line && line !== turn.activity && turn.status === "running")
    emitTurn({ ...turn, activity: line, activityAt: at });
  return { ...result, events: out, turn, attempt, thread };
}

/** What Work owns of an item, which a harness's update never changes. */
/**
 * The items a harness may start: its own work in the turn.
 * Replica memory (c): a constant, the same on every replica.
 */
const HARNESS_ITEM_KINDS: ReadonlySet<string> = new Set<Item["kind"]>([
  "assistant_message",
  "reasoning",
  "tool_call",
  "command",
  "file_change",
  "plan",
  "subagent",
]);

const WORK_OWNED_ITEM_FIELDS = [
  "id",
  "sessionId",
  "turnId",
  "attemptId",
  "parentItemId",
  "position",
  "kind",
  "author",
  "createdAt",
] as const;

function waitingLine(kind: "question" | "approval" | "elicitation"): string {
  return kind === "approval"
    ? "Waiting for your approval"
    : "Waiting for your answer";
}

function appendLocal(
  item: Item,
  delta: { field: "text" | "output"; text: string },
  at: string,
): Item {
  if (delta.field === "output" && item.kind === "command")
    return { ...item, output: item.output + delta.text, updatedAt: at };
  if (
    delta.field === "text" &&
    (item.kind === "assistant_message" || item.kind === "reasoning")
  )
    return { ...item, text: item.text + delta.text, updatedAt: at };
  return item;
}

function newItem(input: {
  id: string;
  draft: ItemDraft | ItemPayload;
  state: IngestState;
  parentItemId: string | null;
  nativeRef: NativeRef | null;
  status: Item["status"];
  at: string;
}): Item {
  const { parentKey: _parentKey, ...payload } = input.draft as ItemDraft;
  const common = {
    id: input.id,
    sessionId: input.state.sessionId,
    turnId: input.state.turn.id,
    attemptId: input.state.attempt.id,
    parentItemId: input.parentItemId,
    // The log sets the position to the sequence that adds it.
    position: 0,
    status: input.status,
    nativeRef: input.nativeRef,
    createdAt: input.at,
    updatedAt: input.at,
    startedAt: input.at,
    endedAt: input.status === "in_progress" ? null : input.at,
  };
  // What Work owns of an item wins over anything the harness sent.
  const item = { ...payload, ...common } as Item;
  if (item.kind === "assistant_message" && item.agentId === null)
    return { ...item, agentId: input.state.agentId };
  return item;
}

/** A JSON value, bounded for the log; deeper nesting stays with the runner. */
export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
