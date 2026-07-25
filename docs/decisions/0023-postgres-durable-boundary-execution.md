# 0023 — Postgres boundary execution

- **Status:** Accepted
- **Date:** 2026-07-23
- **Updated by:** 0026 (boundary executor within the canonical Run coordinator)

## Context

Persisted boundaries need retries and process-independent continuation without
serializing JavaScript stacks or adding queue infrastructure. Existing
production execution already has immutable artifacts, Postgres jobs, and warm
Bun supervisors.

## Decision

One boundary executes per runtime invocation. Postgres stores the
current boundary, input, attempts, output, active invocation, and child links;
the next boundary is always a new queued invocation against the same immutable
artifact. A boundary is the retry unit, so ordinary work inside it reruns after
a semantic boundary failure and is not replayed independently.

Queue delivery retries reuse one logical attempt and are idempotent. Semantic
retries create a new boundary attempt and invocation ID. Child workflows are
canonical child Runs linked to the parent attempt; child success supplies the
parent continuation value. External effects remain at-least-once and require
author-provided idempotency.

Workers coordinate only through Postgres leases and `SKIP LOCKED`. Constructing
core, SDK, or Fastify starts no worker. Hosts explicitly start worker handles,
which use unique incarnation IDs and are asynchronously stopped.

## Consequences

Servers and workers may scale horizontally without shared memory. Dormant runs
consume database rows but no Worker or sandbox invocation. Execution remains
pinned to one artifact and cannot continue on edited source. ADR 0026 places
this executor behind the same Run row, service, routes, SDK, hooks, and UI used
for every Workflow.
