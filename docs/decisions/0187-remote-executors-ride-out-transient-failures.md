# 0187 — Remote executors ride out transient failures on one operation queue

- **Status:** Accepted; a worker's session is its process epoch and any replica runs its agents (0192)
- **Date:** 2026-09-29
- **Refines:** 0098 (This machine runners), 0164 (enrolled workers)

## Context

Control-plane replicas sit behind a load balancer that may send each request
to any replica. A worker's poll, renew, and receipt already worked on any
replica, because the queue and lease live in Postgres, but the worker ended
its whole session on any single failed call. One 502, or one replica
restarting during a deploy, made it reconnect. The reconnect took a new lease
token, which interrupted every turn running on the worker, or it waited up
to 45 seconds for the old lease to lapse. A poll whose response was lost also
lost its operation for good, because the claim stripped the payload.

Workers and member runners used two near-identical queues. The member queue
was never swept, so payloads accumulated in Postgres.

## Decision

**One queue.** `remote_operations` carries sandbox operations to every remote
executor, addressed `node:<id>` or `client:<id>` and fenced by the
executor's lease token. `RemoteOperationQueue` in core owns dispatch, poll,
receipt, and cleanup. The two old tables are dropped.

**Delivery survives lost responses.** Each poll carries an id that the
executor repeats when it retries, and asks for as many operations as the
executor has free slots. A retried poll receives what that poll took and
takes nothing more; polls of one id are serialized with a transaction-scoped
lock. A poll whose caller hung up takes nothing and gives back what it took.
An operation's payload stays until it settles. The controller deletes the
row once it has read the receipt, and abandoned rows are swept after their
expiry. Receipts are idempotent; a receipt for an operation that settled or
was abandoned is refused, never recorded.

**A session ends only on a definite answer.** The runner loop shared by
workers and This machine distinguishes three answers:

- *session ended* (409 from poll or renew, 401, 403): connect again, or stop;
- *receipt refused* (409 from complete): drop that receipt;
- *result rejected* (400 or 413 from complete): report the operation as failed.

Everything else (no answer, a timeout, a 5xx, 408, 429) is transient and
retries the same call with jittered backoff up to five seconds. The lease
window bounds the retries: after it, the control plane answers 409. A
receipt is given up once no controller can still be waiting for it. An
operation runs at most once; only its receipt is retried.

**Long polls everywhere.** Member runners long-poll like workers. A worker
runs one poll loop with one slot per workspace, instead of one polling lane
per workspace. Calls carry timeouts. Stopping aborts a pending poll and
does not wait for running operations: a member's runner stops its
sandboxes, and a worker keeps them for its next session.

Considered: retrying transient failures inside each transport. Rejected,
because the loop owns the poll id and knows which calls are safe to repeat.

## Consequences

A load balancer's error or a replica restarting no longer interrupts work on
workers. A worker's agents still run on the replica holding its lease; if
that replica stops, they stop with it until any replica can run them
(issue 152).

Operation payloads, including a member's personal login during upload (ADR
0184), stay in Postgres while the operation runs rather than until it is
taken. Upgrading drops operations in flight; their controllers already
report them as uncertain. A worker and control plane must run the same
release: an older worker's poll without an id is refused and it reconnects.
