# 0031 — Execution hot-path costs: parked deferrals, bucket round trips, heartbeat HOT updates

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

Three costs left open by [0029](0029-queue-and-rate-correctness-at-scale.md),
measured rather than estimated before deciding what to do about them.

**A paused run spun its jobs forever.** Deferring a paused run rescheduled its
job 100ms out for boundaries and 5s for batch items, so every job on that run
cycled claim → release indefinitely. At a measured 2.95ms per cycle, 10k paused
boundary jobs demand roughly **295 DB-seconds of work per wall-clock second** —
it would saturate Postgres while accomplishing nothing, and the leases count
against `max_concurrent_jobs`, starving the tenant's live work.

**A shared rate bucket capped near 500 reservations/sec.** `reserve` held the
bucket row locked across four sequential round trips (upsert, lock, clock,
update). Throughput measured 189/sec at concurrency 1 and plateaued at 517/sec
at concurrency 100 — adding workers bought nothing, because the row was the
bottleneck. Every workflow sharing a `globalKey` shares that ceiling.

**Heartbeats could never be HOT updates.** `heartbeat` writes
`lease_expires_at` every ~20s per in-flight job, and that column was indexed by
`idx_execution_jobs_lease`. Measured over 1000 heartbeats: **0% HOT, 1100 dead
tuples**. With the index dropped, the identical workload was **100% HOT with 12
dead tuples** — about 90× less work for autovacuum on the busiest table here.

## Decision

**Deferred work on a paused run is parked, not polled.** The defer interval
becomes an hour, and `resume` pulls that run's pending jobs forward in the same
transaction that clears the pause. Spin drops to zero while resume stays
immediate; the hour is a backstop for a missed wake, not the expected path.
`makeRunAvailable` exposes the same wake for any other caller that makes a run
runnable.

**Reservation is two round trips regardless of bucket count.** A single
`INSERT ... ON CONFLICT DO UPDATE` creates-or-locks every bucket and returns
post-lock state, and a single `UPDATE ... FROM (VALUES ...)` writes every
settled bucket. Throughput measured **~1750/sec at concurrency 100 (3.4×)**,
with the ceiling holding across three runs and no crashes.

The token math stays in TypeScript rather than moving into SQL. A pure-SQL
version measured faster still (~3000/sec), but the multi-bucket verdict is
all-or-nothing: a reservation spanning several buckets must consume from all or
none. Expressing that as a window function over a CTE was where the first
attempt went wrong, and the extra ~1250/sec is not worth making the atomicity
rule harder to see.

**`idx_execution_jobs_lease` is dropped** (migration 028). The reaper's
predicate is already served by `idx_execution_jobs_running_by_tenant`, which is
partial on `status = 'running'` and therefore holds only live leases — the
planner did not choose the lease index even when it was present, and reaper
latency measured ~1ms either way against a 200k-row table. Every other
`lease_expires_at` predicate is a fencing check on a row already located by
primary key.

## Consequences

The rate-limit rewrite exposed a trap worth stating plainly, because it is the
same class of bug twice in this codebase. Under `READ COMMITTED`, a CTE that
`SELECT`s a row reads the *statement's snapshot* — taken before any row lock was
granted. The first version computed available tokens in such a CTE, so 24
concurrent callers against a capacity-4 bucket all read the same 4 tokens and
**20 were granted where 4 should have been**. The existing concurrency test
caught it. Correctness here depends on reading through the lock:
`ON CONFLICT DO UPDATE ... RETURNING` re-reads the live row after locking it,
which a plain `SELECT` in a CTE does not.

Parking makes `resume` load-bearing in a way it was not before. Previously a
missed wake cost 100ms; now it costs an hour. That is the price of not burning
the database on paused runs, and the wake is committed in the same transaction
as the status change so it cannot be lost independently — but any future path
that makes a run runnable must wake its jobs.

Dropping the lease index trades a theoretical read path for a measured write
path. If a future reaper needs to seek by expiry across a very large live fleet,
the index can come back — but it should come back partial on something a
heartbeat does not write, and the HOT-ratio regression test will fail loudly if
it does not. That test was verified to fail (0% HOT) with the index restored, so
it is not decorative.

`max_concurrent_jobs` accounting improves for free: parked jobs hold no lease,
so a paused run no longer consumes a tenant's concurrency budget.

Still open from 0029: nothing. The batch-path findings from that review's
reported "quadratic completion" were investigated and rejected there.
