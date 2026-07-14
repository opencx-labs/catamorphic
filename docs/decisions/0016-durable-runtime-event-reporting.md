# 0016 — Durable runtime event reporting

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

ADR 0014 requires incremental, authenticated runtime reporting with Postgres as
the authority. Returning one terminal receipt loses completed step state when a
worker, supervisor, or transport fails. Provider endpoints and credentials must
also remain outside core contracts.

## Decision

Runtime invocations emit ordered events identified by
`(invocationId, sequence)` and step calls by
`(runId, nodeId, occurrence)`. Providers accept a host-side event sink and own
the authenticated transport that moves supervisor events to it. The command
runtime polls an authenticated supervisor event endpoint while invocation
transport is active and flushes the terminal receipt before returning. Provider
URLs, bearer tokens, sandbox paths, and process details never enter the event
sink or persisted payload.

Core validates tenant ownership and transactionally inserts each event before
applying it to `workflow_runs` and `workflow_run_steps`. Duplicate sequences are
no-ops only when their event data matches; conflicting reuse fails. Retries use
a new invocation ID and replay completed outputs by stable node occurrence.
External effects remain at-least-once.

Durable `sleepUntil` and `waitForSignal` are deferred. They require a settled
code-level call-site identity, signal-delivery API, authorization model, and
scheduled-resume state; a runtime-only helper would either restart timers or
consume signals nondeterministically.

## Consequences

Step completion can survive process and queue-worker failure, and replay does
not expose transport details to workflow code or core DTOs. Providers that can
stream or poll can report before process exit; providers without incremental
transport still flush the terminal receipt. Durable waits need a follow-up ADR
and parser/API work rather than an implicit runtime DSL.
