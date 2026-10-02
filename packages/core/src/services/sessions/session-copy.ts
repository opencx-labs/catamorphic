import { randomUUID } from "node:crypto";
import type {
  Item,
  NativeRef,
  SessionSnapshot,
} from "@catamorphic/agent-protocol";
import { isSettledTurnStatus } from "@catamorphic/agent-protocol";

/**
 * A session's settled history through one item, rebased onto another
 * session (ADR 0197): every turn, attempt, item, request and thread gets a
 * fresh id, and every reference to an old id follows it. What a fork
 * starts from.
 */
export function copySettledHistory(input: {
  snapshot: SessionSnapshot;
  sessionId: string;
  /** Up to and including the turn of this item; the whole history when omitted. */
  throughItemId?: string;
}): {
  snapshot: SessionSnapshot;
  /** The source thread the copy's last turn ran on, and that turn's end. */
  forkPoint: {
    threadId: string;
    harness: string;
    source: NativeRef;
    throughTurnRef: NativeRef | null;
  } | null;
} | null {
  const { snapshot } = input;
  let through: Item | undefined;
  if (input.throughItemId) {
    through = snapshot.items.find((item) => item.id === input.throughItemId);
    if (!through) return null;
  }
  const throughTurn = through?.turnId
    ? snapshot.turns.find((turn) => turn.id === through?.turnId)
    : undefined;
  const turns = snapshot.turns.filter(
    (turn) =>
      isSettledTurnStatus(turn.status) &&
      (!throughTurn || turn.ordinal <= throughTurn.ordinal),
  );
  const kept = new Set(turns.map((turn) => turn.id));
  const limit = through
    ? Math.max(
        through.position,
        ...snapshot.items
          .filter((item) => throughTurn && item.turnId === throughTurn.id)
          .map((item) => item.position),
      )
    : Number.POSITIVE_INFINITY;
  const items = snapshot.items.filter(
    (item) =>
      item.position <= limit &&
      // Items of unsettled turns stay behind; messages that started no
      // turn (message_only, notices) come along.
      (item.turnId ? kept.has(item.turnId) : true),
  );
  const attempts = snapshot.attempts.filter((attempt) =>
    kept.has(attempt.turnId),
  );
  const requests = snapshot.requests.filter(
    (request) =>
      request.status !== "pending" &&
      request.turnId &&
      kept.has(request.turnId),
  );
  const last = turns.at(-1);
  const lastAttempt = last
    ? attempts
        .filter((attempt) => attempt.turnId === last.id)
        .sort((a, b) => b.ordinal - a.ordinal)[0]
    : undefined;
  const sourceThread = last?.providerThreadId
    ? snapshot.providerThreads.find(
        (thread) => thread.id === last.providerThreadId,
      )
    : undefined;

  const ids = new Map<string, string>([[snapshot.session.id, input.sessionId]]);
  for (const entity of [...turns, ...attempts, ...items, ...requests])
    ids.set(entity.id, randomUUID());
  const rebase = <T>(value: T): T => rebaseIds(value, ids);
  return {
    snapshot: {
      ...snapshot,
      session: { ...snapshot.session, id: input.sessionId },
      // The copy runs on threads of its own: the source's stay the source's.
      turns: turns
        .map(rebase)
        .map((turn) => ({ ...turn, providerThreadId: null })),
      attempts: attempts
        .map(rebase)
        .map((attempt) => ({ ...attempt, providerThreadId: null })),
      items: items.map(rebase),
      requests: requests.map(rebase),
      providerThreads: [],
      olderBefore: null,
    },
    forkPoint:
      sourceThread?.nativeRef && sourceThread.nativeRef.strength !== "none"
        ? {
            threadId: sourceThread.id,
            harness: sourceThread.harness,
            source: sourceThread.nativeRef,
            throughTurnRef: lastAttempt?.nativeTurnRef ?? null,
          }
        : null,
  };
}

function rebaseIds<T>(value: T, ids: ReadonlyMap<string, string>): T {
  return JSON.parse(
    JSON.stringify(value, (_key, field: unknown) =>
      typeof field === "string" ? (ids.get(field) ?? field) : field,
    ),
  ) as T;
}
