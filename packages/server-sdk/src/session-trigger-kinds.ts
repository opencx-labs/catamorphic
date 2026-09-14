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
].map((name) =>
  defineTriggerKind({
    name,
    modes: ["async"],
    display: {
      label: name.slice(8).replaceAll("-", " "),
      icon: "messages-square",
    },
    description:
      "A durable session transition. Select a session or agent in config; inspect event-time state in input.payload and read current state with catamorphic.sessions.inspect. Turn completion does not mean work completion.",
    payload: sessionEventPayload,
    config,
    correlationKey: (event) => event.id,
    matches: ({ config, payload: event }) => {
      const value = event.payload;
      return (
        (!config.sessionId || config.sessionId === value.sessionId) &&
        (!config.agentId || config.agentId === value.agentId) &&
        (!config.workStatus ||
          config.workStatus === value.session.workStatus) &&
        (!config.statuses ||
          config.statuses.includes(
            String(value.detail.status ?? value.session.status),
          ))
      );
    },
  }),
);
