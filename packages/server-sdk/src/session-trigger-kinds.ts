import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

const sessionEventPayload = z.object({
  id: z.string(),
  sequence: z.number(),
  projectId: z.string(),
  source: z.literal("session"),
  kind: z.string(),
  externalId: z.string(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  payload: z.object({
    sessionId: z.string(),
    agentId: z.string().nullable(),
    externalUserId: z.string(),
    session: z.object({
      id: z.string(),
      /** The chat's key (ADR 0173), e.g. `pr-acme/web-42`; null when unkeyed. */
      key: z.string().nullable(),
      title: z.string().nullable(),
      status: z.enum(["active", "closed"]),
      workStatus: z.enum(["open", "completed"]),
      activity: z.string().nullable(),
      parentSessionId: z.string().nullable(),
      stateRevision: z.number(),
      authorityHostId: z.string(),
      authorityRevision: z.number(),
    }),
    actor: z.record(z.string(), z.unknown()),
    causation: z.array(z.string()),
    detail: z.record(z.string(), z.unknown()),
  }),
});
const config = z.strictObject({
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  statuses: z.array(z.string()).min(1).optional(),
  workStatus: z.enum(["open", "completed"]).optional(),
  /** session.result-recorded: only results of these names (ADR 0323). */
  names: z.array(z.string()).min(1).optional(),
});
/** Domain events are emitted by core on both hosts, transactionally with state. */
export const SESSION_TRIGGER_KINDS = [
  "session.created",
  "session.message-received",
  "session.message-sent",
  "session.turn-changed",
  "session.state-changed",
  "session.work-changed",
  "session.authority-changed",
  // An agent submitted a result that passed its schema (ADR 0323);
  // `detail.name` is the result's name.
  "session.result-recorded",
  // A chat's workspace was made, made again, moved, given back or lost
  // (ADR 0324); `detail.change` is what happened.
  "session.workspace-changed",
  // A running turn made no progress for its agent's stall threshold
  // (ADR 0333); `detail` names the turn, attempt and what it last reported.
  "session.turn-stalled",
].map((name) =>
  defineTriggerKind({
    name,
    modes: ["async"],
    display: {
      label: name.slice(8).replaceAll("-", " "),
      icon: "messages-square",
    },
    description:
      name === "session.result-recorded"
        ? 'An agent\'s accepted typed result, the moment it is recorded (mid-turn). The result is in input.payload.detail (name, value, turnId, input, commit); select names in config, a session or agent, or keyed chats with where on payload.session.key. A newer input to the chat makes it stale: check detail.input against catamorphic.sessions.read with include: ["results"].'
        : name === "session.turn-stalled"
          ? "A running turn made no progress for its agent's stall threshold (the definition's stall.minutes), recorded once per silence. input.payload.detail has turnId, attemptId, attempt, attempts, restarts, progressAt, stalledAt, stallMinutes and activity (tool calls and commands still running). Work does nothing on its own: read the chat, collect diagnostics with exec, and restart with catamorphic.sessions.restart, bounding it with restarts."
          : "A durable session transition. Select a session or agent in config, or keyed chats with where on payload.session.key (a { $prefix } matches a key namespace); inspect event-time state in input.payload and read current state with catamorphic.sessions.read. Turn completion does not mean work completion.",
    payload: sessionEventPayload,
    config,
    deliveryKey: (event) => event.id,
    matches: ({ config, payload: event }) => {
      const value = event.payload;
      return (
        (!config.sessionId || config.sessionId === value.sessionId) &&
        (!config.agentId || config.agentId === value.agentId) &&
        (!config.workStatus ||
          config.workStatus === value.session.workStatus) &&
        (!config.names || config.names.includes(String(value.detail.name))) &&
        (!config.statuses ||
          config.statuses.includes(
            String(
              value.detail.change ??
                value.detail.status ??
                value.session.status,
            ),
          ))
      );
    },
  }),
);
