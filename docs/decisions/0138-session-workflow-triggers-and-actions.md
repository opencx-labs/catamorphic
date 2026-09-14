# 0138: Session workflow triggers and actions

- **Status:** Accepted
- **Date:** 2026-09-14
- **Refines:** 0039, 0074, 0076, 0077, 0087, 0090, 0101, 0124

## Context

Agents need temporary timed wakeups and workflows that react to session changes,
inspect current state, and take attributed session actions on either host.
Desktop-only callbacks and unlinked message labels cannot provide that contract.

## Decision

Use ordinary workflow enablements for temporary and durable automation. `schedule`
accepts either an absolute one-shot `at` or recurring `cron` and `timezone`. Both
use persisted occurrences and the same activation dispatcher. Temporary source
and retained results keep the session-artifact lifecycle from 0124.

Session changes publish typed Project Events transactionally with durable state.
Session creation, messages, turn transitions, lifecycle, and explicit work
completion have distinct meanings. A settled turn is not a declaration that work
is finished. Event payloads include event-time session state and attribution;
workflow reads obtain current state. Trigger kinds own validated constant config
matching. Optional session/agent/status selectors are routing filters; arbitrary
conditions remain TypeScript. Dispatch receipts survive terminal runs and retries.

Agents and workflows use shared session operations with live identity checks:
inspect/list, create/fork/subsession, deliver, interrupt, archive/unarchive, attention,
and explicit completion. Subsessions retain delegation grants and fresh context by
default. Mutation history carries actor, originating session, workflow/run and
activation references. Delivery author, model instructions, and queue policy remain
separate: workflow messages cannot acquire host instruction authority by naming a
role. Host adapters preserve model-visible provenance.

Event ingress, execution placement, and session authority remain independent.
Durable delivery follows authority fencing and waits while its host is offline.
Both stock hosts run the same dispatch machinery. Causal provenance prevents an
activation from retriggering itself; bounded chains stop cycles across activations.
Stop, expiry and archive prevent future runs while retaining completed evidence.

## Consequences

Chat renders concise action entries and linked authors, with source/run details
available without obscuring the conversation. Authoring skills teach event-time
versus current state, idempotent actions, explicit completion, finite lifetimes,
and silence on unchanged conditions. Restart, duplicate, expiry, authority handoff,
and local/remote scenario tests are part of the contract.
