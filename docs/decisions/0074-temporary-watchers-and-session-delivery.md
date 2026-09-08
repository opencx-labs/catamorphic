# 0074: Temporary Watchers and durable session delivery

- **Status:** Accepted (Watcher trigger model superseded by 0076)
- **Date:** 2026-08-28
- **Refines:** 0039, 0061, 0067
- **Supersedes in part:** 0068, 0069

## Context

Agents need to babysit external activity after a turn ends. A useful watcher
must be able to run arbitrary TypeScript workflow logic, retain explicit
authority and placement, and optionally message or wake a session. The earlier
Watch design covered host-owned conditions, while chat queueing lived in one
React client and external messages could only masquerade as user messages.

GitHub also demonstrates three independent locations: webhook or polling
ingress, workflow execution, and the authoritative agent session. Treating any
one of those as the location of the others prevents remote events from safely
waking local sessions.

## Decision

**A Monitor observes; a Watcher runs code.** Host and plugin Monitor providers
observe processes, files, ports, HTTP, Git, CodeHost state, and other external
systems. They append deduplicated typed Project Events. A Watcher subscribes to
Project Events and starts an ordinary Workflow Run for each accepted event.
Conditions and actions remain TypeScript workflow code. There is no condition
DSL or database-authored wake expression.

Watcher source is an ordinary `defineWorkflow` snapshot committed to a
dedicated `catamorphic/watchers/<watcher-id>` git ref. It is never merged into
project `main`. The Watcher pins that commit, its deployment artifact,
Environment, owner session and agent, exact connections, capability ceiling,
event subscriptions, expiry, and resource limits. Remote execution fetches the
same ref and commit. Expiry removes the activation and ref; immutable git
objects may be garbage-collected later. This is temporary reviewed execution,
not a personal artifact under ADR 0068.

**Session delivery is durable and server-owned.** Session messages carry an
author (`user`, `agent`, `workflow`, `watcher`, or `system`), source ids, content,
structured metadata, and one delivery policy:

- `message_only`: append visibly without invoking the model;
- `next_turn`: invoke immediately when idle or queue behind the running turn;
- `interrupt`: interrupt the running turn, then queue the message.

`next_turn` is the wake operation for an idle or old active session. Closed
sessions remain terminal. Durable turn records serialize provider commands and
replace the React-owned authoritative queue. Provider adapters may project a
non-user author onto their transport's user role, but must preserve the origin
in the model-visible envelope and transcript metadata.

Ingress placement, Watcher execution Environment, and session authority are
independent. Cross-host delivery uses a durable mailbox addressed to the
authoritative session. Desktop clients maintain an authenticated outbound
connection or poll to linked remotes, so offline messages wait without an
inbound desktop listener. Session handoff updates authority; stale mirrored
forks never receive new turns.

All operations are canonical gateway capabilities. Agent, project, role, and
host policy intersect over source kinds, target scope, delivery modes,
maximum lifetime, concurrency, event rate, and cost. Same-project
`message_only` is the least privileged operation. Interrupting another session
asks by default. Every event, Watcher invocation, message delivery, and
authority transition is idempotent, auditable, and instrumented.

GitHub is the first complete external source. GitHub App webhooks on reachable
hosts and authenticated polling on desktop normalize into the same event
schema and deduplicate by provider identity. Repository access is verified
through the existing GitHub and CodeHost seams. A generic webhook provider may
be added later without changing Watchers.

## Consequences

- Temporary automation remains code-first and executes an exact immutable
  revision without polluting the shared project branch.
- A workflow chooses whether to wake a session by invoking the session
  delivery capability. Silent completion is a valid Watcher result.
- UI clients render durable inbox and Watcher state rather than owning it.
- Existing `CodingAgentProvider`, client queue authority, and the condition
  object previously called Watch are removed as their replacements land.
- ADR 0068's ban on remote personal artifacts remains. A Watcher is a separate
  consent-bound temporary deployment with explicit authority and expiry.
