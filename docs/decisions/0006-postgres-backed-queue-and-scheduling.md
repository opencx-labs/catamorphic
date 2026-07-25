# 0006 — Postgres-backed job queue and scheduling

- **Status:** Accepted (queue/retry/pause execution implemented by 0014, 0016, and 0023-0026; cron triggers remain future work)
- **Date:** 2026-07-02
- **Implemented and updated by:** 0014, 0016, 0023, 0024, 0025, 0026

## Context

At the time of this decision, Runs were synchronous request/response: the HTTP
handler blocked until the sandbox finished. Persisted continuation needed queued
execution, retries, scheduled resumes, and long wait semantics. Adding
Redis/BullMQ or a hosted queue would burden every host with extra infrastructure.

## Decision

Queueing and scheduling are built on the **same host Postgres**, inside the
`catamorphic` schema, using `FOR UPDATE SKIP LOCKED` polling. No new
infrastructure dependencies.

Intended shape:

- An `execution_jobs` table in the `catamorphic` schema; workers are host
  processes that explicitly opt in with `catamorphic.startExecutionWorker()`.
- Run triggering becomes enqueue + poll/notify; the HTTP API returns a pending run immediately.
- Authored `pause()` with a timeout is a durable timer: the Run suspends and a
  scheduled job resumes it. Plain `sleep()` remains non-durable.
- Cron triggers are rows, not crontabs.

## Consequences

- Hosts scale workers horizontally with plain processes; Postgres is the only coordination point.
- Throughput ceiling is Postgres's — acceptable for workflow workloads (bursty, seconds-to-days latency tolerance), revisit if a host outgrows it.
- ADRs 0023-0026 implement queued Runs, retries, persisted pauses, cancellation,
  boundaries, and batch scopes on Postgres. Cron trigger management remains
  outside the current surface, and plain `sleep()` remains non-durable.
