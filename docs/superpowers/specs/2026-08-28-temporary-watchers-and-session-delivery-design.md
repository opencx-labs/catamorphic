# Temporary Watchers and Session Delivery Design

## Status

Approved in conversation on 2026-08-28 and recorded by ADR 0074. The Watcher
trigger model in section 3 was simplified and superseded by ADR 0076 and the
2026-08-29 Watcher trigger unification design. Session delivery, Monitors,
placement, policy, and observability remain current.

## Purpose

Let an agent create a temporary TypeScript workflow that reacts to durable
project events after its turn ends and may send an attributed message to any
authorized session. GitHub is the first complete event source. The framework
contracts work in the desktop, stock server, embedded hosts, and remote
Environments without desktop-only execution paths.

## Invariants

1. Workflow logic is TypeScript and is never represented by a JSON condition
   or action DSL.
2. Every Watcher Run executes the exact immutable commit and deployment
   artifact pinned at Watcher creation.
3. Watcher source never lands on project `main` unless a later agent change
   deliberately promotes it.
4. Session queueing and interruption are durable server operations. React is
   a view and command client.
5. A non-user message is never persisted or shown as authored by the user.
6. Event ingress, workflow execution, and session authority are independent.
7. Provider credentials remain in the control plane and Watcher authority is
   explicit, revocable, finite, and auditable.

## 1. Durable session delivery

`AgentMessage` gains structured authorship and source provenance. User sends,
agent-to-agent messages, workflow messages, and Watcher messages all enter
through `AgentSessionsService.deliver()`:

```ts
type SessionMessageAuthor =
  | { kind: "user"; externalUserId: string }
  | { kind: "agent"; sessionId: string; agentId: string | null }
  | { kind: "workflow"; runId: string; workflowName: string }
  | { kind: "watcher"; watcherId: string; runId?: string }
  | { kind: "system"; code: string };

type SessionDeliveryMode = "message_only" | "next_turn" | "interrupt";
```

The service writes the message and, for a model-invoking delivery, a durable
`agent_turns` row in one transaction. A unique idempotency key makes webhook
redelivery and retried capability calls safe. At most one turn is running per
session. Pending turns are ordered by priority and sequence; `interrupt`
requests interruption once and then becomes the next pending turn.

The turn worker owns provider dispatch, recovery, and terminal status. HTTP
send returns the accepted message and turn id without holding the request open
for model completion. Clients poll or subscribe to existing session/runtime
events. The React queue and its optimistic authority are deleted.

The transcript stores domain authorship separately from provider roles.
Provider adapters receive a model-visible origin envelope for agent, workflow,
and Watcher messages. A session's own assistant output remains `assistant`.

## 2. Project Events and Monitors

`ProjectEventsService.append()` accepts a typed event envelope with source
kind, source instance, event name, provider event id, occurred time, payload,
and sanitized subject metadata. `(project, source instance, provider event
id)` is unique. Append commits before subscribers run.

`ProjectEventSourceProvider` is a host-injected registry entry. It describes
event schemas, ingress requirements, supported delivery strategies, and the
operations needed to start, refresh, and stop a project Monitor. Providers may
be event-backed or polled. Poll claims use `FOR UPDATE SKIP LOCKED` and store a
cursor only after appended events commit.

GitHub registers one source provider. Reachable servers expose a
signature-verified GitHub App webhook route. The desktop uses the same
provider in polling mode through the existing user GitHub connection. Both
emit `github.pull_request`, `github.pull_request_review`,
`github.check_run`, `github.check_suite`, and `github.workflow_run` events.

## 3. Temporary Watcher deployments

An agent supplies normal workflow TypeScript, then calls `watchers.create`
with the exported workflow name, source, target Environment, expiry, limits,
and allowed session-delivery ceiling. Subscriptions exist only as ordinary
inline `trigger()` declarations in that source. They are never a separate API
or database input.
Creation performs the following transaction boundary:

1. read and parse the checkout at its current checkpoint;
2. scan the selected export through `TriggersService`, validate its ordinary
   trigger bindings and event input schema;
3. create a commit and push `catamorphic/watchers/<watcher-id>`;
4. create or verify the deployment artifact for that exact commit;
5. admit the Environment and exact connections;
6. persist the Watcher lifecycle, pinned revision, capability ceiling, and
   expiry while reusing the frozen per-commit trigger projection.

The source ref is lifecycle plumbing, not a second workflow model. Runs use
the existing canonical `workflow_runs` state machine with Watcher provenance.
The Watcher dispatcher correlates by `(watcher, project event)` and creates at
most one Run. Concurrency defaults to one; later events coalesce or queue under
the Watcher's explicit policy.

Watcher workflows receive the normalized event payload. They may invoke
`sessions.deliver`, `watchers.stop`, or any other admitted capability from a
`"use step"` function. No delivery happens merely because a Run completed.

## 4. Placement and cross-host mailboxes

Every session records an authority host id and revision. A host may claim
authority only through the existing explicit continuation/handoff path.
Messages addressed to another host enter a durable outbox. The authoritative
host acknowledges imports idempotently. Desktop linked-remotes polling runs on
focus, wake, and a short active interval; a future streaming transport can
replace polling without changing the mailbox contract.

If GitHub polling and the session are both on the desktop, delivery is local.
If a server receives a webhook for a desktop-authoritative session, it queues
the mailbox item until the desktop connects. If the session was continued on
the server, the authority revision routes it there and the stale desktop fork
remains locked.

## 5. Policy and guidance

Canonical capabilities are `watchers.create/list/get/stop`,
`sessions.deliver`, and Monitor administration. Existing layered tool policy
applies first. Typed constraints then cap source kinds, same-project versus
cross-project targets, delivery modes, active Watcher count, lifetime, event
rate, Run concurrency, and cost. Project and host ceilings cannot be widened
by an agent definition.

Default doctrine permits same-project `message_only` and `next_turn` for
visible sessions, asks before `interrupt`, denies cross-project delivery, and
requires finite Watcher expiry. Agent guidance says to prefer `next_turn`,
state what is being watched and where, use a terminal condition, and stop the
Watcher when babysitting is finished.

## 6. Reference-host experience

The desktop adds a Watchers activity section and session chips showing source,
Environment, expiry, last event, last Run, delivery ceiling, and status. Users
can inspect source and Runs, pause or stop the Watcher, and see attributed
Watcher/agent/workflow messages in chat. GitHub-linked projects expose the
GitHub event source automatically when the current user can read the
repository; unavailable access is an actionable authentication state.

The PWA renders the same attributed messages and remote Watcher state. It does
not run desktop polling itself.

## 7. Failure and observability

Project event append, Monitor poll, Watcher dispatch, Run creation, session
delivery, turn claim, interruption, and mailbox import emit OTel spans with
Catamorphic ids but no raw payloads. Poll and turn claims are lease-fenced.
Provider event ids, Watcher dispatch keys, message idempotency keys, and
mailbox ids make every boundary at-least-once and effect-once.

Revoked GitHub or connection access suspends the Monitor or Watcher with a
typed reason. Expiry is terminal. A failed Watcher Run is visible and follows
its declared retry/concurrency policy; it does not automatically wake the
session with an invented error message.

## Delivery sequence

1. Durable session messages, turn queue, worker, APIs, and React queue removal.
2. Project Events, Monitor provider registry, and GitHub webhook/poll source.
3. Watcher source refs, lifecycle, dispatcher, and workflow capabilities.
4. Cross-host mailbox routing and desktop/PWA Watcher experience.

Each phase is a breaking replacement. No dual writes, compatibility aliases,
or client-authoritative fallback remain after its cutover.
