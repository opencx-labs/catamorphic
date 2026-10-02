import type {
  AssistantMessageItem,
  Item,
  ItemCommon,
  RuntimeRequest,
  SessionEvent,
  SessionFields,
  SessionSnapshot,
  StoredSessionEvent,
  Turn,
  UserMessageItem,
} from "@catamorphic/agent-protocol";
import { HttpResponse } from "msw";

export const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
export const SESSION_ID = "00000000-0000-4000-8000-000000000003";

const AT = "2026-10-01T10:00:00.000Z";

/** An ISO time `seconds` after the fixtures' epoch. */
export function at(seconds: number): string {
  return new Date(Date.parse(AT) + seconds * 1000).toISOString();
}

export function sessionFields(
  overrides: Partial<SessionFields> = {},
): SessionFields {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    title: null,
    icon: null,
    agentId: "assistant",
    model: null,
    modelEffort: null,
    status: "active",
    workStatus: "open",
    activity: null,
    todos: [],
    parentSessionId: null,
    forkedFromSessionId: null,
    attentionRevision: 0,
    environment: null,
    authorityHostId: "host",
    authorityRevision: 1,
    handoffStatus: "none",
    updatedAt: AT,
    ...overrides,
  };
}

export function turn(
  id: string,
  ordinal: number,
  overrides: Partial<Turn> = {},
): Turn {
  return {
    id,
    sessionId: SESSION_ID,
    ordinal,
    status: "completed",
    inputItemId: `${id}:input`,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    // A turn waiting in the queue has not run yet.
    attemptCount:
      overrides.status === "queued" ||
      overrides.status === "held" ||
      overrides.status === "cancelled"
        ? 0
        : 1,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: at(ordinal * 10),
    startedAt: at(ordinal * 10 + 1),
    completedAt: null,
    updatedAt: at(ordinal * 10 + 1),
    ...overrides,
  };
}

function common(
  id: string,
  position: number,
  turnId: string | null,
): ItemCommon {
  return {
    id,
    sessionId: SESSION_ID,
    turnId,
    attemptId: null,
    parentItemId: null,
    position,
    status: "completed",
    nativeRef: null,
    createdAt: at(position),
    updatedAt: at(position),
    startedAt: at(position),
    endedAt: at(position),
  };
}

export function userMessage(
  id: string,
  position: number,
  turnId: string | null,
  text: string,
  overrides: Partial<UserMessageItem> = {},
): UserMessageItem {
  return {
    ...common(id, position, turnId),
    kind: "user_message",
    author: { kind: "user", externalUserId: "test-user" },
    text,
    attachments: [],
    dispatch: "queue",
    attention: null,
    idempotencyKey: null,
    metadata: {},
    ...overrides,
  };
}

export function reply(
  id: string,
  position: number,
  turnId: string,
  text: string,
): AssistantMessageItem {
  return {
    ...common(id, position, turnId),
    kind: "assistant_message",
    text,
    agentId: "assistant",
  };
}

export function toolCall(
  id: string,
  position: number,
  turnId: string,
  tool: string,
): Item {
  return {
    ...common(id, position, turnId),
    kind: "tool_call",
    tool,
    server: null,
    description: null,
    input: {},
    result: null,
    error: null,
  };
}

export function requestItem(
  id: string,
  position: number,
  turnId: string,
  requestId: string,
): Item {
  return { ...common(id, position, turnId), kind: "request", requestId };
}

export function notice(
  id: string,
  position: number,
  code: string,
  text: string,
): Item {
  return {
    ...common(id, position, null),
    kind: "notice",
    code,
    text,
    data: {},
  };
}

export function question(
  id: string,
  overrides: Partial<RuntimeRequest> = {},
): RuntimeRequest {
  return {
    id,
    sessionId: SESSION_ID,
    turnId: "t1",
    attemptId: null,
    itemId: null,
    kind: "question",
    status: "pending",
    answerable: true,
    blocking: true,
    title: "Question",
    description: null,
    origin: { kind: "tool", id: "ask_user" },
    questions: [
      {
        question: "Which layout?",
        header: "Layout",
        multiSelect: false,
        options: [
          { label: "Grid", description: "Cards" },
          { label: "List", description: "Rows" },
        ],
      },
    ],
    approval: null,
    elicitation: null,
    approvers: [],
    expiresAt: null,
    response: null,
    resolvedBy: null,
    reason: null,
    createdAt: AT,
    resolvedAt: null,
    ...overrides,
  };
}

export function snapshot(
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    sequence: 0,
    session: sessionFields(),
    turns: [],
    attempts: [],
    items: [],
    requests: [],
    providerThreads: [],
    olderBefore: null,
    ...overrides,
  };
}

/** The session detail `GET …/sessions/:id` answers with. */
export function sessionDetail(snap: SessionSnapshot) {
  return {
    ...snap.session,
    workStatus: "open",
    stateRevision: 0,
    externalUserId: "test-user",
    owner: "member",
    source: "desktop",
    sandboxId: null,
    allocationId: null,
    visibility: "promoted",
    archivedAt: null,
    authoritySeenAt: AT,
    mirrorSequence: 0,
    handoffDestinationHostId: null,
    resumable: true,
    pausedAt: null,
    running: false,
    attentionSeenRevision: 0,
    attentionRequired: false,
    key: null,
    keyWorkflows: [],
    placement: null,
    workspace: null,
    baseCommitSha: null,
    createdAt: AT,
    snapshot: snap,
  };
}

export function stored(
  sequence: number,
  event: SessionEvent,
  commandId: string | null = null,
): StoredSessionEvent {
  return {
    sessionId: SESSION_ID,
    sequence,
    at: at(sequence),
    commandId,
    event,
  };
}

/**
 * A controllable server-sent-event response: push frames with `send`,
 * end the connection with `close`.
 */
export function sseStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      closed = true;
    },
  });
  return {
    response: () =>
      new HttpResponse(body, {
        headers: { "content-type": "text/event-stream" },
      }),
    send(message: unknown, id?: number) {
      if (closed) return;
      controller?.enqueue(
        encoder.encode(
          `${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(message)}\n\n`,
        ),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      controller?.close();
    },
  };
}
