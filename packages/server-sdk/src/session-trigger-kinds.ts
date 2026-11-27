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
  // An agent asked for something its turn waits on (ADR 0352): an
  // approval, a question or an elicitation, in `detail`.
  "session.request-opened",
  // A chat's workspace is being set up (ADR 0355): the turn waits for the
  // runs this event starts for the project's automations.
  "session.workspace-setup",
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
          : name === "session.request-opened"
            ? "An agent asked for something its turn waits on: an approval (a tool set to ask, a harness permission, a guard's escalation), a question or an elicitation. input.payload.detail has requestId, kind, title, description, origin, approval { action, details, tool { server, name, input } }, questions, elicitation, turnId and expiresAt. Answer with catamorphic.sessions.answer({ sessionId, requestId, response, idempotencyKey }); narrow with where on payload.detail.kind or payload.agentId. While a project automation listens, an approval in a chat no one watches waits for its answer (two minutes by default) instead of being refused at once, so answer every one you receive: denied with a reason when it should not run."
            : name === "session.workspace-setup"
              ? 'A chat\'s workspace is being set up, and its turn waits for this workflow: every run this event starts for a project automation must end before the agent starts, within the Environment\'s setup.timeoutMinutes. input.payload.detail has reason (created, rebuilt, base-moved or changed), environment, workspace { ref, commit }, previous { commit } (the base this sandbox last set up on, or null) and sandbox: "new" (Work made it and ran the Environment\'s setup.command) or "kept" (the one the chat already used: Work replaced nothing and ran nothing). Decide by calling operations, not by what the workflow returns: catamorphic.sessions.changedPaths compares previous.commit with workspace.commit, and catamorphic.sessions.exec with in: "setup" runs a command as setup does. In a kept sandbox whose setup has a network of its own, the first in: "setup" command has Work make a new sandbox (base checked out, setup.command run) and runs there, so ask for it before anything else; with none, the sandbox and what it installed stay. A failed run, or one past the deadline, is a failed setup: the agent is told and it runs again before the next turn. Narrow with where on payload.detail.environment or payload.session.key.'
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
