# ADR 0087: Workflow-woken sessions are the notification record

- **Status:** Accepted
- **Date:** 2026-09-03
- **Refines:** 0068, 0074, and 0077

## Context

An unattended workflow often needs an agent to investigate, produce a useful
result, and bring that result back to one member. Creating a parallel
notification inbox would split the result, its context, and the place where
the user can continue the work. Creating a fresh conversation on every cron
occurrence would also flood the sidebar and discard useful continuity.

Service-owned workflow enablements do not identify a human recipient. A
personal notification therefore cannot be inferred safely from service
authority.

## Decision

The built-in `catamorphic.sessions.wake` host call creates or reuses one
active agent session for the member and a stable key scoped to the workflow.
It queues an attributed agent turn and returns immediately. Run retries are
idempotent. The project role must grant both the workflow and the selected
project agent, and the agent's ordinary Environment and connection admission
still applies.

When that turn settles, the session increments a durable attention revision.
Opening the session acknowledges the latest revision. Desktop and PWA clients
render unacknowledged attention as a pulsing dot, distinct from the desktop's
local solid unread dot. The desktop also materializes the session as a
minimized dock bubble without taking focus. Web Push remains an optional
delivery channel and deep-links to the same session; the session list remains
the durable notification record.

`wake` is allowed for ad hoc member runs and member-owned enablements. It
fails closed for service-owned enablements because they have no personal
sidebar recipient. Existing `catamorphic.sessions.deliver` remains the path
for a workflow or watcher that already has an explicit session id.

## Consequences

Recurring summaries accumulate in one continuable conversation instead of
creating notification clutter. Attention state follows the server identity
across clients and survives restarts. Workflow authors must choose a stable
key and a committed agent slug, while hosts need no new notification-center
surface or provider-specific integration.
