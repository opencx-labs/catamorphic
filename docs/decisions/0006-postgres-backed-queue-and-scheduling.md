# 0006 — Postgres-backed job queue and scheduling

- **Status:** Accepted (not yet implemented)
- **Date:** 2026-07-02

## Context

Runs today are synchronous request/response: the HTTP handler blocks until the sandbox finishes. Durable workflows need queued execution, retries, cron-style triggers, and long `sleep("7 days")` semantics. Adding Redis/BullMQ or a hosted queue would burden every host with extra infrastructure.

## Decision

When queueing and scheduling land, they are built on the **same host Postgres**, inside the `catamorphic` schema, using `FOR UPDATE SKIP LOCKED` polling (the pg-boss/graphile-worker pattern — implemented directly or by embedding one of those libraries if it fits the schema-scoping requirement). No new infrastructure dependencies.

Intended shape:

- A `jobs` (or similar) table in the `catamorphic` schema; workers are just host processes that opt in (`catamorphic.startWorker()`), so single-process hosts work out of the box.
- Run triggering becomes enqueue + poll/notify; the HTTP API returns a pending run immediately.
- `sleep()` in workflows becomes a durable timer: the run suspends, a scheduled job resumes it (this interacts with the execution harness design and may require workflow-level checkpointing — to be designed in its own ADR).
- Cron triggers are rows, not crontabs.

## Consequences

- Hosts scale workers horizontally with plain processes; Postgres is the only coordination point.
- Throughput ceiling is Postgres's — acceptable for workflow workloads (bursty, seconds-to-days latency tolerance), revisit if a host outgrows it.
- Until implemented, runs remain synchronous and `sleep()` is not durable.
