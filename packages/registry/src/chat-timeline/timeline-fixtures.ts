/**
 * Builders for timeline tests: sessions as the server's snapshot would
 * carry them, read through the same projection every client uses.
 */
import { sessionStateFromSnapshot } from "@catamorphic/agent-protocol";
import {
  type AssistantMessageItem,
  type InboundMessageItem,
  type Item,
  type RuntimeRequest,
  sessionTimeline,
  type TaskNotificationItem,
  type TimelineTurn,
  type Turn,
  type UserMessageItem,
  type WorkItem,
} from "@catamorphic/react";

const EPOCH = Date.parse("2026-10-01T10:00:00.000Z");
const at = (seconds: number) => new Date(EPOCH + seconds * 1000).toISOString();

export function turn(
  id: string,
  ordinal: number,
  overrides: Partial<Turn> = {},
): Turn {
  return {
    id,
    sessionId: "s",
    ordinal,
    status: "completed",
    inputItemId: `${id}:input`,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 1,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: at(ordinal * 100),
    startedAt: at(ordinal * 100 + 1),
    completedAt: at(ordinal * 100 + 90),
    updatedAt: at(ordinal * 100 + 90),
    ...overrides,
  };
}

let position = 0;

function common(id: string, turnId: string | null, seconds?: number) {
  position += 1;
  const time = at(seconds ?? position);
  return {
    id,
    sessionId: "s",
    turnId,
    attemptId: null,
    parentItemId: null,
    position,
    status: "completed" as const,
    nativeRef: null,
    createdAt: time,
    updatedAt: time,
    startedAt: time,
    endedAt: time,
  };
}

export function input(
  turnId: string,
  text: string,
  overrides: Partial<UserMessageItem> = {},
): UserMessageItem {
  return {
    ...common(`${turnId}:input`, turnId),
    kind: "user_message",
    author: { kind: "user", externalUserId: "me" },
    text,
    attachments: [],
    dispatch: "queue",
    attention: null,
    idempotencyKey: null,
    deliveredBy: null,
    causation: [],
    ...overrides,
  };
}

/** Words another agent or a workflow sent (ADR 0217). */
export function inbound(
  id: string,
  turnId: string | null,
  text: string,
  overrides: Partial<InboundMessageItem> = {},
): InboundMessageItem {
  return {
    ...common(id, turnId),
    kind: "inbound_message",
    from: { kind: "workflow", runId: "run-1", workflowName: "prReview" },
    text,
    attachments: [],
    dispatch: "queue",
    attention: null,
    idempotencyKey: null,
    deliveredBy: null,
    causation: [],
    ...overrides,
  };
}

/** Work's notification about a task the agent started (ADR 0217). */
export function notification(
  id: string,
  turnId: string | null,
  summary: string,
  overrides: Partial<TaskNotificationItem> = {},
): TaskNotificationItem {
  return {
    ...common(id, turnId),
    kind: "task_notification",
    task: {
      type: "background_command",
      id: "cmd-1",
      title: "Start the worker",
      status: "update",
    },
    summary,
    detail: `Matching lines:\n${summary}`,
    source: { kind: "surface", key: "terminal:worker" },
    dispatch: "queue",
    attention: null,
    idempotencyKey: null,
    deliveredBy: null,
    causation: [],
    ...overrides,
  };
}

export function reply(
  id: string,
  turnId: string,
  text: string,
  overrides: Partial<AssistantMessageItem> = {},
): AssistantMessageItem {
  return {
    ...common(id, turnId),
    kind: "assistant_message",
    text,
    agentId: null,
    ...overrides,
  };
}

export function command(
  id: string,
  turnId: string,
  overrides: Partial<Extract<WorkItem, { kind: "command" }>> = {},
): Item {
  return {
    ...common(id, turnId),
    kind: "command",
    command: `run-${id}`,
    description: null,
    output: "",
    exitCode: 0,
    ...overrides,
  };
}

export function toolCall(
  id: string,
  turnId: string,
  overrides: Partial<Extract<WorkItem, { kind: "tool_call" }>> = {},
): Item {
  return {
    ...common(id, turnId),
    kind: "tool_call",
    tool: "Read",
    server: null,
    description: null,
    input: {},
    result: null,
    error: null,
    ...overrides,
  };
}

export function fileChange(
  id: string,
  turnId: string,
  path: string,
  overrides: Partial<Extract<WorkItem, { kind: "file_change" }>> = {},
): Item {
  return {
    ...common(id, turnId),
    kind: "file_change",
    path,
    change: "modified",
    previousPath: null,
    ...overrides,
  };
}

export function notice(
  id: string,
  code: string,
  text: string,
  data: Extract<Item, { kind: "notice" }>["data"] = {},
): Item {
  return {
    ...common(id, null),
    kind: "notice",
    code,
    text,
    data,
  };
}

/** The timeline a session with these turns, items and requests reads as. */
export function timelineOf(input: {
  turns: Turn[];
  items: Item[];
  requests?: RuntimeRequest[];
}): TimelineTurn[] {
  return sessionTimeline(
    sessionStateFromSnapshot({
      sequence: 1,
      session: {
        id: "s",
        projectId: "p",
        title: null,
        icon: null,
        agentId: null,
        harness: null,
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
        authorityHostId: "local",
        authorityRevision: 1,
        handoffStatus: "none",
        updatedAt: at(0),
      },
      turns: input.turns,
      attempts: [],
      items: input.items,
      requests: input.requests ?? [],
      providerThreads: [],
      olderBefore: null,
    }),
  );
}
