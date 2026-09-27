# 0179 — Integrations from project code: named HTTP operations and declared delivery ids

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0162, 0171, 0172, 0138

## Context

Slack is the proving case that an integration is project code on host
primitives (#117): a trigger library over the `webhook` kind, workflows that
keep one chat per thread, and a service connection through the gateway. Three
gaps stood in the way, none of them Slack-specific:

- An `http` gateway connection's actions were the HTTP methods. Slack's Web
  API is `POST /api/<method>` for everything, so a binding could say "may
  POST" but not "may call `chat.postMessage`": the path allowlist belonged to
  the gateway entry, not to the binding, and the capability that roles and
  bindings narrow was the method.
- Webhook ingress deduplicated only by delivery-id headers. Slack (and
  Stripe) carry the event's id in the body; a Slack retry
  (`x-slack-retry-num`) became a second event and a second run.
- A workflow reacting to a settled turn could not read the reply it settled
  with: `history` returned the newest messages without the chat's key, and a
  host call's result replaces a boundary's state, so the turn's
  `resultMessageId` could not be carried to the read.

## Decision

**Named HTTP operations.** An `http` gateway entry may declare `actions`:
`{ name, method, path, description? }`. When present they are the
connection's only actions: each has a fixed method and exact path (the caller
passes `query`, `headers`, and `body`, never `path`), the connection's
capabilities are the action names, and bindings, roles, workflow declarations
and guards narrow them by name (`"capabilities": ["conversations.replies",
"chat.postMessage"]`). `actions` and `paths` are exclusive. Workflows call
them as `context.connections.slack.chat.postMessage({ body })`, since the
connection namespace already joins the path after the alias with dots. The
AI SDK harness maps tool names to the characters model APIs accept.

**Declared delivery ids.** A webhook binding may declare `deliveryId`, a
value under `body`, `query` or `headers` (`"body.event_id"`). It is the
event's stored identity before the delivery-id headers, so a sender's retry
is stored once and answered as a duplicate. Like `verify` and `respond`, it
is part of the endpoint's settings every binding of the name must share.

**History as of an event.** `history` returns the chat's `key` and accepts
`through: <messageId>` to end at that message, so a workflow triggered by
`session.turn-changed` reads exactly the reply named by the event's
`resultMessageId` and knows which thread the chat belongs to.

The Slack integration itself ships as the host skill `slack`: the gateway
entry and bindings, the `slack.event`, `slack.mention` and `slack.message`
trigger kinds, a workflow delivering each thread to the project chat keyed
`slack:<channel>:<thread_ts>`, a workflow posting the settled reply back to
the thread, and how agents read and cite Slack. The setup guide gains
"Connect Slack". No Slack code exists in the framework.

Considered: capabilities of the form `post:/chat.postMessage` (a second
capability grammar every consumer would have to parse), a `slack` connection
provider (integration code in the framework), and a trigger-kind `payload`
mapper computing the delivery id (project code on the control plane, rejected
in 0171).

## Consequences

- Any RPC-style API (Slack, Stripe's action endpoints, internal services) can
  be granted per operation; guards scope by operation name.
- Slack's retries start no second run, and handshakes stay synchronous.
- A reply workflow runs once per settled turn of every project chat and stays
  quiet unless the chat's key is a Slack thread. Session events do not carry
  the key, so `where` cannot select Slack chats yet.
- Slack users map to project members only where the project commits a
  mapping; a mapped name is attribution in the delivered message, never the
  member's authority. Staying quiet in busy threads waits on group chats
  (#92). Searching Slack (`search.messages`) needs a user token, so it is a
  separate service connection or each member's own.
