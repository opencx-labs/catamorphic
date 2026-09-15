/** Shared authoring guidance offered to every harness through host skill discovery. */
export const SESSION_WORKFLOWS_SKILL = `---
name: session-workflows
description: Author Catamorphic workflows for timed wakeups, recurring checks, session lifecycle events, and attributed session actions. Use for ephemeral session monitors and durable agent automations.
---

# Session workflows

Use workflow-lifecycle to choose source ownership and activation, writing-workflows
for TypeScript shape, and durable-workflows when designing transitions. Temporary
and permanent enablements use the same defineWorkflow, trigger, and host calls.
Discover this host's actual capabilities and schemas before authoring.

## Choose the action

| Request | Delivery | Lifetime |
| --- | --- | --- |
| Remind the user | deliver with mode: "message_only", attention: "required" | One-shot schedule owned by the session, no default expiry |
| Wake an agent to do work | deliver with mode: "next_turn" | One-shot or conditional monitor; stop when its purpose is complete |
| Monitor events without noise | Inspect the event/state, then deliver only a meaningful change | Session watcher or explicitly enabled reusable workflow |
| Have an agent prepare a recurring result in a stable chat | wake with a stable workflow-scoped key | Member-owned enablement; reuse the same session |

Neither saving source nor deploying alone turns a trigger on. A workflow return
ends that run, not its recurring activation.

## Clock and event selection

schedule config is exactly one of { at: "2026-09-14T12:00:00Z" } or
{ cron: "*/5 * * * *", timezone: "Asia/Amman" }. Resolve relative times from the
current clock once when authoring. at fires once, including after an offline
host returns, provided the activation has not expired. Cron coalesces missed
occurrences. Input is { activationId, scheduledFor, firedAt }. Omit expiresInSeconds
for reminders: they have no default expiry and survive months offline. An explicit
expiry is a separate user-requested deadline, never a substitute for scheduled time.
Local session watchers stay on the local host and use its Environment. They cannot
run while that host is stopped; overdue one-shots run once when it returns. Closing
a chat leaves reminders active. Archiving cancels all its watchers and those of
its subsessions, including paused ones; restoring the chat does not restart them.
When confirming a reminder, tell the user its resolved date and time, which host
runs it, that an offline local host delivers it late, and that archiving cancels it.

Session event kinds: session.created, session.message-received, session.message-sent,
session.turn-changed, session.state-changed, session.work-changed, and
session.authority-changed. Config may select sessionId, agentId, statuses, and
workStatus. Omitting sessionId observes authorized matching sessions in the
project. Example: trigger("session.turn-changed", { sessionId: "actual-id",
statuses: ["completed", "failed"] }). Never guess an id.

Events are normalized Project Events. input.payload.session is the snapshot at
the transition; input.payload.detail contains the message/turn/visibility change.
input.payload.actor identifies the initiator. message-received means inbound context;
message-sent means a settled assistant segment, never a token update. A workflow can use ordinary if
statements over those values. Read current state with the inspect host transition
when a decision needs fresh state; optionally pass expectedStateRevision with
the subsequent mutation. Event state and current state may legitimately differ. A remote mirror may lag
its authority host; expectedStateRevision is checked where the mutation is applied.

A completed turn is not completed work. Turns can end while waiting for another
session or queued work. Use session_complete to explicitly declare work finished,
and session_reopen for new work. Observe session.work-changed with
{ workStatus: "completed" } when the task, rather than one turn, matters.

## Host calls and authoring shape

context.host["catamorphic.sessions"] provides typed inspect, list, history,
deliver, wake, create, fork, spawn, archive, unarchive, interrupt,
complete, reopen, stopWatcher, and stop operations. Every host call is a
boundary transition: RETURN it. Consume its result as the next boundary's input.
Do not await it, put it inside a use-step helper, or invoke a second host call
in the same boundary. Put ordinary network/file IO in use-step helpers with
one destructured object parameter and JSDoc display names.

### Agent wakeup

A self-wake uses this shape. Replace the example timestamp from the current clock,
and use the actual session id and requested work:

\`\`\`typescript
import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
/** @displayname Follow up */
export const followUp = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("schedule", { at: "2026-09-14T12:00:00Z" })],
  steps: [
    /** @displayname Wake the session */
    defineBoundary({
      run: (context: BoundaryContext<{ activationId: string; scheduledFor: string; firedAt: string }>) =>
        context.host["catamorphic.sessions"].deliver({
          sessionId: "REPLACE_WITH_CURRENT_SESSION_ID",
          content: "Continue the requested follow-up. Inspect current state first.",
          mode: "next_turn",
          idempotencyKey: context.input.activationId + ":" + context.input.scheduledFor,
        }),
    }),
    /** @displayname Stop the temporary activation */
    defineBoundary({
      run: (context: BoundaryContext<unknown>) =>
        context.host["catamorphic.sessions"].stop({ idempotencyKey: "stop" }),
    }),
  ],
}));
\`\`\`

For a monitor, replace the first boundary with a bounded check and branch on a
meaningful change. Finish silently when nothing needs action. Persist a checkpoint
in ordinary durable project/app data if the external source has no stable event
identity. A failed HTTP request is not evidence that the monitored job failed.
Use timeouts and limited retries. Return enough state between boundaries to keep
the target session id, original event id, and decision evidence available.

### Completion monitor

A reusable completion monitor can use broad routing plus an ordinary predicate.
Save this in project source, replace the target id, and explicitly enable it:

\`\`\`typescript
import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
type Completion = { id: string; payload: { sessionId: string; session: { parentSessionId: string | null; workStatus: "open" | "completed" } } };
/** @displayname Watch child completion */
export const childCompletion = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("session.work-changed", { workStatus: "completed" })],
  steps: [
    /** @displayname Notify the parent */
    defineBoundary({
      run: (context: BoundaryContext<Completion>) => {
        const event = context.input;
        const parentId = "REPLACE_WITH_PARENT_SESSION_ID";
        if (event.payload.session.parentSessionId !== parentId || event.payload.session.workStatus !== "completed") {
          return { matched: false };
        }
        return context.host["catamorphic.sessions"].deliver({
          sessionId: parentId,
          mode: "message_only",
          attention: "required",
          content: "A child session finished its work. Inspect its result before continuing.",
          idempotencyKey: "child-finished:" + event.id,
        });
      },
    }),
  ],
}));
\`\`\`

This monitor intentionally remains enabled for later children. For one child,
create a temporary watcher and filter its exact sessionId in trigger config. If
predicates can reject an event, branch the stop boundary too: a quiet return from
one boundary does not skip the next boundary. Stop only after a matching action. The stop operation belongs to temporary activations.
Use inspect in a preceding boundary if current state must supersede the event
snapshot. deliver with message_only and attention: "required" requests user attention without running a model;
use deliver with next_turn when the parent agent should continue automatically.

### User reminder

For a reminder that needs no agent work, deliver the message directly and stop the
temporary activation. Keep scheduledFor in the content so late delivery is clear.
Replace the example date, target, and text before creating the watcher.

\`\`\`typescript
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";
type Schedule = { activationId: string; scheduledFor: string; firedAt: string };

/** @displayname Send reminder */
export const remindUser = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("schedule", { at: "2026-09-21T09:00:00+03:00" })],
  steps: [
    /** @displayname Deliver reminder */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<Schedule>) =>
        host["catamorphic.sessions"].deliver({
          sessionId: "REPLACE_WITH_CURRENT_SESSION_ID",
          content: "Reminder: review the proposal. Scheduled for " + input.scheduledFor,
          mode: "message_only",
          attention: "required",
          idempotencyKey: input.activationId + ":" + input.scheduledFor,
        }),
    }),
    /** @displayname Stop reminder */
    defineBoundary({
      run: ({ host }: BoundaryContext<unknown>) =>
        host["catamorphic.sessions"].stop({ idempotencyKey: "stop" }),
    }),
  ],
}));
\`\`\`

## Session actions and delivery

- inspect/list/history are authorized reads. history is bounded; increase its
  limit only when needed. Read a child as an ordinary session.
- deliver message_only records context without a model turn; next_turn starts
  work when idle or queues behind the active turn; interrupt requests a course
  change. The host preserves origin in model input and in visible history.
  Authoring a workflow message does not grant system/developer instruction rank.
- wake creates/reuses a stable member session and requests attention when its
  agent turn settles. Its optional notification title/body customizes that alert.
  It is member-only; service-owned enablements have no implicit personal recipient.
  Grant the project agent and its required connections/Environment. Use deliver
  when the session id is known. Choose a stable wake key to reuse the conversation.
- spawn respects the source agent's configured delegation routes. Fresh context
  is the default. fork explicitly copies transcript history; create makes an
  independent conversation. Do not simulate children as untracked shell agents.
- attention: "required" on deliver alerts the user to that exact message. It is
  independent of mode and defaults to none. Use message_only for a reminder to
  the user; use next_turn for work the agent should perform. Do not run a model
  merely to display a reminder. Notification preferences affect alerts, not the
  retained message or its unread attention. Repeated delivery with the same key
  creates one message and one attention request.
- archive stops the session tree's work and future temporary activations while
  preserving readable history. Follow archive preview and confirmStop requirements for stopping live work. Tab closure is
  unrelated. stop stops only the calling temporary activation and retains runs.

Use stable idempotencyKey values for operations that take them; wake uses its
stable key and the host's run receipts. Reuse the same action key for retries of the
same action; use a different key for a new action. Do not use a fresh random key
on each boundary retry. Prefer event identity or activationId + scheduledFor.
Causal chains prevent self-triggering and bounded multi-workflow loops; do not
attempt to evade that protection by discarding provenance.

## Placement and verification

Reusable project workflows can observe a trigger or target a session on another
host. Session-owned watchers still run on their owner's host and Environment.
Remote delivery may remain queued while a desktop is offline. It does not
move session authority. A remote mutation returns delivery: "queued" and a messageId,
not the completed action result or a newly created child. Branch on that receipt
before using a create/fork/spawn result; inspect or watch for the resulting event.
Inspect the returned receipt and retained run rather than
claiming the user or model received a queued message already.

Before reporting an automation active, inspect its enabled status, source revision,
Environment, expiry, and next intended behavior. Check authored source with the
project checker. Verify one real occurrence or controlled event, including the
quiet path. Ensure a finite monitor stops itself, and show the user its workflow
or artifact link. Never introduce permanent polling to satisfy a one-time wake.
`;
