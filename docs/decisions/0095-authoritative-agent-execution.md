# 0095: Authoritative agent execution and independent connections

- **Status:** Accepted
- **Date:** 2026-09-06

## Context

Message placeholders, HTTP requests, and process-local flags cannot reliably
describe an agent on another server. A quiet provider can still be working;
replaying a prompt after a broken connection can duplicate real side effects.

## Decision

The existing `agent_turns` record owns execution state. Persist its phase and
last observed provider activity separately from its executor lease. Heartbeats
prove executor ownership, not model progress. Clients render this snapshot;
message content and request latency never determine whether the agent is running.
Show preparation and saving explicitly. Silence alone never triggers a retry.

Only the host's execution worker reconciles abandoned attempts. Reads never
change execution. A client may reconnect or close without affecting the worker.
Authority remains fenced by host and revision under ADR 0077; a remote mirror
must not dispatch or settle the source host's work.

Complete the long-lived runtime cutover from ADR 0067 using acknowledged
commands and sequenced events. Persist command identity before submission and
reconcile an uncertain acknowledgement against the same provider attempt before
starting any new attempt. Provider reconnect and turn retry are different
operations. Do not automatically resend a user prompt after an ambiguous
transport failure. Explicitly unsupported recovery stops visibly for review.

Durable transitions drive deduplicated notifications. Client-to-server connection
health stays local to that client; it does not rewrite server execution state.
Remote execution and notifications require no desktop window to remain open.

## Consequences

Desktop, mobile, and remote hosts share execution semantics. Tests must cover
lost acknowledgements, duplicate delivery, quiet tools, expired ownership,
provider death, and disconnected clients. Greenfield contracts may break rather
than preserve competing execution models.
