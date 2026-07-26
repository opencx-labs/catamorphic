# 0029 — Queue claim cost, lease fencing, and rate budget accuracy at scale

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

0028 replaced the one-job-per-tenant claim with a set-based weighted query and
argued its cost "does not grow with tenant count". That was true, but it traded
the wrong axis: the query ranked the **entire pending set** on every poll.
Measured against a seeded backlog, a single `claim(20)` took 3.4ms at 1k pending
jobs, 121ms at 100k, and 243ms at 200k — linear, with a sequential scan and an
external merge sort spilling 5.7MB to disk. Every worker repeated that work on
every poll, so adding workers made the contention worse rather than better. At
the 100k-item batch sizes this system is meant for, the queue would have spent
more time deciding what to run than running it.

Three further defects surfaced while measuring, each verified by reproduction
rather than by reading:

**The rate limiter over-admitted by ~2.8×.** `reserve` read
`transaction_timestamp()` — fixed at BEGIN — *before* waiting on the bucket's
`FOR UPDATE`. Lock-grant order is not transaction-start order, so a caller that
queued behind the lock stamped `refilled_at` **earlier** than the holder before
it. The next caller then computed elapsed time from that rewound mark and
credited tokens for time already spent. A bucket of capacity 10 refilling at
200/s granted 131 reservations where 47 was the ceiling. For a shared WhatsApp
or ESP account, that is the exact outcome the table exists to prevent. The same
path also crashed: float subtraction of equal magnitudes lands at -6.7e-16,
which the `tokens >= 0` check constraint rejects.

**A worker loop died permanently on any transient database error.** The
`while (!signal.aborted)` body had no error handling. One connection reset
during a failover exited the loop for the process lifetime, silently retiring a
concurrency slot and surfacing as an unhandled rejection.

**Batch state transitions bypassed lease fencing.** `completeStep`/`failStep`
fence only when handed a job (`args.job && !(await ownsJob(...))`). Four batch
call sites had the job in scope and did not pass it. A worker whose lease had
expired and been reclaimed could still call `failStep`, whose `cleanupStepScope`
cancels **every** job for that step — killing the healthy work its replacement
was doing.

## Decision

**The claim selects per tenant, not across the backlog.** A recursive
`tenant_walk` skip-scans the distinct tenants holding pending work through
`idx_execution_jobs_pending_rank`, then each contributes only its own top slice
via `CROSS JOIN LATERAL`. Cost now tracks the number of tenants with a backlog —
an axis bounded by the installation — instead of backlog depth, which is not
bounded at all. All five fairness contracts from 0028 are preserved verbatim.

`SET LOCAL jit = off` wraps the statement. Postgres cannot estimate a recursive
CTE's cardinality, so it guessed ~23,000 rows for a query touching a few dozen
index entries and triggered JIT: 21ms of compilation against 0.3ms of execution.
This was worth isolating — the plan was already optimal, and the entire
remaining cost was the optimizer reacting to its own bad estimate.

**Reservation reads the clock after taking the lock**, using `clock_timestamp()`
so the value reflects when the bucket was actually held. Consumed tokens are
clamped at zero.

**The worker loop catches, reports, and backs off exponentially** (capped at
30s) rather than exiting.

**Terminal rows are revived on dedupe conflict.** `enqueue`'s
`ON CONFLICT DO UPDATE` previously touched only `updated_at`, so re-enqueueing a
key whose job had failed left it terminal and unclaimable — a batch retrying its
sink would wedge with no job and no timeout. A live row still absorbs the
duplicate, which is what dedupe is for; a terminal one resets to pending.

**The four batch call sites now pass their job**, so every state transition they
drive is fenced on the lease.

## Consequences

Claim latency is flat at ~3ms from 1k to 200k pending jobs, against 243ms at
200k before — 68× at the top of the measured range, and no longer degrading.
The regression test asserts the *shape* rather than an absolute number: it
compares claim cost at 2k against 40k and fails if the ratio exceeds 8×. It was
confirmed to fail against the old query, so it cannot pass vacuously.

Rate budgets hold their ceiling under contention (verified across 1500
concurrent reservations, zero over-admission, zero crashes). The single-row
`FOR UPDATE` still serializes a shared bucket at roughly 200-250 reservations/s
per `globalKey`; the lock is correctly not held across the sandbox call, so this
is a throughput ceiling rather than a correctness problem, and it is the next
thing to address if a tenant needs more than that through one account.

**Not addressed here, and the largest remaining risk: there is no retention.**
No purge, archive, or TTL exists for `execution_jobs`, `workflow_run_events`,
`workflow_step_attempts`, `batch_items`, `batch_item_steps`, or
`batch_step_members`. `workflow_runs` is never deleted, so every `ON DELETE
CASCADE` in the schema is unreachable. A 100k-item batch with a 5-node pipeline
writes on the order of 1.5M rows; run daily, that is ~550M rows a year. The
claim path itself is insulated — its indexes are partial on live statuses — but
`uq_execution_job_dedupe` is partial only on `dedupe_key IS NOT NULL`, so it
retains an entry for every job ever enqueued and is the first thing expected to
degrade. Heartbeats compound it: they update the indexed `lease_expires_at`
every ~20s per in-flight job, defeating HOT updates and keeping autovacuum
behind. Retention needs its own ADR.

One reported "quadratic completion" defect was investigated and **rejected**:
the per-completion backlog `COUNT(*)` looks unbounded, but the source
high-water mark holds only ~100 items non-terminal, so the index seeks directly
to them. Measured at 0.03ms and flat from 1k to 100k items. The apparent
quadratic behaviour only appears if every item is pending simultaneously, which
the watermark prevents.
