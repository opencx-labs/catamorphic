# 0094: Durable agent reconnects and unexpected-stop visibility

- **Status:** Accepted
- **Date:** 2026-09-06

## Context

Agent turns already have a durable inbox, but retries lived in process timers
and running leases were never renewed. A restart could lose a reconnect, while
a read from another executor could incorrectly settle healthy work. Ordinary
failed turns did not consistently alert their owner.

## Decision

Use the existing `agent_turns` queue for initial execution, manual retry, and
automatic retry. Persist the result and retry deadline together; reuse the
request and failed response instead of adding another user message. Renew the
executor's fenced lease while it is alive. Database time decides queue readiness.
Retry confirmed pre-execution rejections with capped exponential backoff and
jitter. An error category alone never authorizes replay (ADR 0095). A waiting
retry keeps its place ahead of later queued work. A new human
message or Stop cancels the pending retry.

Hosts explicitly start `startAgentWorker` after migrations and resolve current
user authority before unattended dispatch. Only the authoritative host dispatches
its queue. Expired execution with an uncertain outcome stops visibly and requires
an explicit retry; lease expiry is not permission to replay side effects or take
over another host. Preserve partial output. A stream ending without a terminal
event is failure, not a successful preamble.

Unexpected failures request attention and publish deduplicated notifications
through the existing durable Web Push outbox. Periodic reconciliation recovers
missed failure notifications. Intentional stops do not generate failure alerts.
Desktop and stock server share the optional host-side Web Push transport in
`@catamorphic/server-sdk/web-push`; the framework still accepts an injected transport.
Failed delegated work is promoted and reports back to its parent.
The running delegation remains pending until its idempotent parent delivery
succeeds. The worker recovers missed results without rerunning completed work.

## Consequences

Scheduled retries survive process restarts without duplicating queued requests. Lost
host connectivity is shown as unknown progress, not asserted agent activity.
No timeout is imposed on quiet reasoning or legitimate long-running tools.
Web Push still requires an opted-in, supported secure mobile installation; a
powered-off or offline host cannot itself deliver an alert until reachable.
