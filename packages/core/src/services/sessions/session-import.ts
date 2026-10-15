import { randomUUID } from "node:crypto";
import {
  type Attempt,
  type ImportedItem,
  type ImportedTranscript,
  type ImportedTurn,
  type Item,
  importedTitle,
  type SessionEvent,
  type Turn,
  type UserMessageItem,
} from "@catamorphic/agent-protocol";

/**
 * Another tool's transcript as session events (ADR 0233). A session that
 * has some of it already gets only what is new or changed (turns the
 * transcript leaves out are left alone): turns are
 * matched by their attempt's native turn ref, items by their native ref,
 * so each read of a file that is still growing appends to the same chat.
 * Ids are Work's; every one of them is kept once allocated.
 */
export function importedTranscriptEvents(input: {
  sessionId: string;
  /** The person the session belongs to: who wrote its user messages. */
  owner: string;
  transcript: ImportedTranscript;
  /** The session's turns, items and attempts of the turns the transcript names. */
  existing: { turns: Turn[]; attempts: Attempt[]; items: Item[] };
  /** The session's last turn ordinal: new turns follow it. */
  lastOrdinal: number;
}): SessionEvent[] {
  const { sessionId, owner, existing } = input;
  const turnsByKey = new Map<string, { turn: Turn; attempt: Attempt }>();
  for (const attempt of existing.attempts) {
    const turn = existing.turns.find(
      (candidate) => candidate.id === attempt.turnId,
    );
    if (turn && attempt.nativeTurnRef)
      turnsByKey.set(attempt.nativeTurnRef.id, { turn, attempt });
  }
  const itemsByKey = new Map<string, Item>();
  for (const item of existing.items)
    if (item.nativeRef) itemsByKey.set(item.nativeRef.id, item);
  let ordinal = input.lastOrdinal;
  const events: SessionEvent[] = [];

  for (const imported of input.transcript.turns) {
    const known = turnsByKey.get(imported.key);
    const turnId = known?.turn.id ?? randomUUID();
    const attemptId = known?.attempt.id ?? randomUUID();
    const inputItem = imported.input
      ? userMessage({
          sessionId,
          owner,
          turnId,
          imported: imported.input,
          existing: itemsByKey.get(imported.input.key),
        })
      : undefined;
    if (inputItem) push(events, inputItem, itemsByKey);
    const turn = importedTurn({
      sessionId,
      turnId,
      attemptId,
      ordinal: known?.turn.ordinal ?? ++ordinal,
      inputItemId: inputItem?.item.id ?? known?.turn.inputItemId ?? null,
      imported,
    });
    if (!known || changed(known.turn, turn, ["updatedAt"]))
      events.push({ type: "turn.changed", turn });
    const attempt = importedAttempt({
      sessionId,
      turnId,
      attemptId,
      imported,
    });
    if (!known || changed(known.attempt, attempt, []))
      events.push({ type: "attempt.changed", attempt });
    for (const item of imported.items)
      push(
        events,
        importedItem({
          sessionId,
          turnId,
          attemptId,
          imported: item,
          existing: itemsByKey.get(item.key),
          parentItemId: item.parentKey
            ? (itemsByKey.get(item.parentKey)?.id ?? null)
            : null,
        }),
        itemsByKey,
      );
  }
  return events;
}

/** The session's title from its transcript: the tool's own, else its first words. */
export function importedSessionTitle(
  transcript: ImportedTranscript,
): string | null {
  if (transcript.title) return transcript.title;
  const first = transcript.turns.find((turn) => turn.input)?.input;
  return first ? importedTitle(first.text) : null;
}

/** An item to add, or to change when it differs from what was imported before. */
interface Placed {
  item: Item;
  existing: Item | undefined;
}

function push(
  events: SessionEvent[],
  placed: Placed,
  itemsByKey: Map<string, Item>,
): void {
  const key = placed.item.nativeRef?.id;
  if (key) itemsByKey.set(key, placed.item);
  if (!placed.existing) {
    events.push({ type: "item.added", item: placed.item });
    return;
  }
  if (changed(placed.existing, placed.item, ["updatedAt"]))
    events.push({ type: "item.changed", item: placed.item });
}

/** Whether two records differ in anything but the fields named. */
function changed<T extends object>(
  before: T,
  after: T,
  ignored: readonly (keyof T)[],
): boolean {
  const strip = (value: T) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !(ignored as readonly string[]).includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  return strip(before) !== strip(after);
}

function userMessage(input: {
  sessionId: string;
  owner: string;
  turnId: string;
  imported: NonNullable<ImportedTurn["input"]>;
  existing: Item | undefined;
}): Placed {
  const { imported, existing } = input;
  const item: UserMessageItem = {
    id: existing?.id ?? randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: null,
    parentItemId: null,
    position: existing?.position ?? 0,
    status: "completed",
    nativeRef: { id: imported.key, strength: "strong" },
    createdAt: imported.at,
    updatedAt: existing?.updatedAt ?? imported.at,
    startedAt: imported.at,
    endedAt: imported.at,
    kind: "user_message",
    author: { kind: "user", externalUserId: input.owner },
    text: imported.text,
    attachments: [],
    dispatch: "queue",
    attention: null,
    idempotencyKey: null,
    deliveredBy: input.owner,
    causation: [],
  };
  return { item, existing };
}

function importedItem(input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  imported: ImportedItem;
  existing: Item | undefined;
  parentItemId: string | null;
}): Placed {
  const { imported, existing } = input;
  const settled = imported.status !== "in_progress";
  const item = {
    id: existing?.id ?? randomUUID(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    parentItemId: input.parentItemId,
    position: existing?.position ?? 0,
    status: imported.status,
    nativeRef: { id: imported.key, strength: "strong" as const },
    createdAt: existing?.createdAt ?? imported.at,
    updatedAt: existing?.updatedAt ?? imported.at,
    startedAt: existing?.startedAt ?? imported.at,
    endedAt: settled ? (existing?.endedAt ?? imported.at) : null,
    ...imported.item,
  } satisfies Item;
  return { item, existing };
}

function importedTurn(input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  ordinal: number;
  inputItemId: string | null;
  imported: ImportedTurn;
}): Turn {
  const { imported } = input;
  const updatedAt = imported.completedAt ?? imported.startedAt;
  return {
    id: input.turnId,
    sessionId: input.sessionId,
    ordinal: input.ordinal,
    status: imported.status,
    inputItemId: input.inputItemId,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 1,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: imported.error ? { message: imported.error } : null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: imported.startedAt,
    startedAt: imported.startedAt,
    completedAt: imported.completedAt,
    updatedAt,
  };
}

function importedAttempt(input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  imported: ImportedTurn;
}): Attempt {
  const { imported } = input;
  return {
    id: input.attemptId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    ordinal: 1,
    reason: "initial",
    status: imported.status,
    providerThreadId: null,
    nativeTurnRef: { id: imported.key, strength: "strong" },
    error: imported.error ? { message: imported.error } : null,
    createdAt: imported.startedAt,
    startedAt: imported.startedAt,
    completedAt: imported.completedAt,
  };
}
