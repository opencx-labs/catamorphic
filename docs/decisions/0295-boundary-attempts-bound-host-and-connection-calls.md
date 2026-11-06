# 0295 - Boundary attempts bound host and connection calls

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

A boundary's sandbox callback has a five-minute execution limit, but a returned
host, documents, or connection operation runs afterward without that limit or
the execution lease's cancellation signal. A stuck provider can therefore hold
an execution worker indefinitely. Retrying a job also starts a fresh sandbox
timeout, allowing one logical attempt to extend its budget after recovery.

## Decision

One boundary attempt has one five-minute budget, measured from its persisted
`workflow_step_attempts.started_at`. The sandbox callback and any returned host,
documents, or connection operation share that absolute deadline. Job redelivery
does not reset it; a boundary-policy retry creates a new attempt and budget.
Rate admission happens before the attempt starts. Durable pause and child waits
do not keep an execution timer alive after the boundary returns.

Reuse the execution job's lease and shutdown signal. Check the database's active
run, attempt, and job ownership immediately before dispatching a returned call.
Pass the combined signal and absolute deadline to host functions and connection
providers, forwarding cancellation to their transport where supported. Stop
awaiting work at cancellation or deadline even if a provider ignores the signal;
keep result persistence fenced by the run, active attempt, and job lease.

We do not add a second queue, cancellation registry, or timeout persistence
model. The existing attempt timestamp and execution lease are authoritative.

## Consequences

Hung asynchronous providers cannot indefinitely hold a worker lane. Cancellation
on another replica is observed through the existing lease heartbeat. Providers
must propagate the signal to SDK or HTTP requests and check it before effects.
An ignored signal can leave work running outside the awaited lane; JavaScript
cannot preempt blocking synchronous code. Cancellation cannot undo an external
effect already accepted, so idempotency, reconciliation, and receipts remain
application responsibilities. A connection requirement redelivery retains the
attempt's original budget.
