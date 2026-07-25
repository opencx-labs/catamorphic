# 0025 — Persisted cancellation state machine

- **Status:** Accepted
- **Date:** 2026-07-23
- **Updated by:** 0026 (one canonical Run state machine and control surface)

## Context

Cancellation can race active boundary completion, pauses, retries, and child
Workflows. Provider cancellation is best-effort, while persisted state must have
one authoritative outcome.

## Decision

Cancellation is an idempotent host control. Postgres first marks the run
`cancel_requested`, cancels pending jobs and open pauses, and propagates the
request to nonterminal children. Active runtime invocation IDs are persisted
and canceled best-effort after commit. Once no active invocation or child
remains, the run becomes terminal `canceled`.

All completion and continuation transactions require the run to remain active;
therefore cancellation and completion have one row-lock winner. Cancellation
never produces a boundary value, starts no next boundary, and performs no
compensation for effects already started.

## Consequences

Postgres remains authoritative even when a provider cannot stop compute.
Cancellation latency depends on active invocation termination and child
propagation, while repeated requests remain safe.
