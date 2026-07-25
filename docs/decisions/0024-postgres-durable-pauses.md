# 0024 — Postgres persisted pauses and timeouts

- **Status:** Accepted
- **Date:** 2026-07-23
- **Updated by:** 0026 (pauses are capabilities on canonical Runs)

## Context

An authored pause must survive server, supervisor, and sandbox replacement.
Explicit resume and timeout can race, and retries from clients or workers must
not enqueue duplicate continuations.

## Decision

Reaching `pause()` commits a stable pause row containing state and an optional
deadline, marks the run waiting, and ends the runtime invocation. Timeouts are
ordinary Postgres jobs scheduled with `available_at`; no in-memory timer is
authoritative.

Resume targets a pause ID with a required idempotency key and JSON value. Resume
and timeout lock the same pause row; exactly one changes `open` to `resumed` or
`timed_out` and transactionally enqueues the next boundary. Reusing a key with
the same payload returns the prior result; conflicting reuse fails. A pause is
not an operator pause and plain `sleep()` does not persist continuation.

## Consequences

Waiting scales with Postgres storage rather than active compute. Scheduler
delay may postpone execution, but database deadline comparison determines the
winner. No Redis, hosted scheduler, or always-live server is required.
