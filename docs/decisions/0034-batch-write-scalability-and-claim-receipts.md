# 0034 — Batch admission counters, concurrent sinks, and claim receipts

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

A review of the recent scalability work (0029–0031 and the write-path batching
that followed) surfaced two classes of remaining problems: hot paths that were
still quadratic or structurally serial, and coordination bugs where a crash or
an in-flight race silently lost a wakeup or a terminal side effect.

**Physical batch admission was O(members²) under a global lock.** Admitting an
item to a coalesced batch step took `pg_advisory_xact_lock` on the
compatibility key, then re-read *every member of every open candidate
invocation* to re-derive how full it was — per admission. The advisory lock
serializes all admissions for the key, so the whole coalescing window cost
O(members²) in payload bytes inside the serial section.

**Sink writes were structurally serial.** `writeBatch` threads a `state` value
from one chunk to the next through a single `sink_state` row, so the scheduler
only ever enqueued one chunk job at a time. Correct for stateful sinks,
needless for the common append-only sink: flush time was O(items/100) round
trips through sandbox invocation no matter what the sink did.

**The exhaustion claim was at-most-once.** `exhaustion_handled_at` was stamped
before the terminal handler ran. A crash between stamp and handler left the
job permanently "handled" with no side effect: the run never failed
terminally, and the retention guard then kept its whole tree forever.

**A resume could miss leased jobs.** Paused-run jobs park an hour out, and
resume pulls forward only `pending` jobs. A job still leased when the resume
committed was then released with the full hour's parking — the "backstop"
interval became the actual latency.

**Batched event ingestion could cross payloads.** The insert built payloads in
a map keyed by `sequence` alone, but a batch may interleave events from
several invocations. Colliding sequences attached one event's payload to
another's row and masked genuine sequence conflicts.

Also: `value_reference`/`output_reference` on `batch_items` were dead columns
(no writer ever produced a reference; the executor hard-failed on one), the
prepared-source cache evicted FIFO rather than LRU, and cold-start sandbox
tuning was hardcoded.

## Decision

**Admission counters on the invocation row.** `batch_step_invocations` carries
`member_count` and `member_bytes`, maintained by the same advisory-lock-
serialized transaction that admits members (and only on a winning insert, so
redelivery cannot double-count). Candidate selection now filters on the
counters in SQL and admission is O(1). (Migration 031.)

**Sinks declare write concurrency.** `BatchSink.concurrency` (default 1,
capped at 16) is captured once at sink start via `inspect` and persisted as
`batch_execution_states.sink_concurrency`. The chunk scheduler enqueues up to
that many pending chunks at once; per-chunk dedupe keys make top-ups
coordination-free, and finalize waits for *every* chunk to complete rather
than for the pending set to drain. State and concurrency are mutually
exclusive, enforced twice: a sink with `initialize` cannot declare
concurrency > 1, and a concurrent sink that returns state from `writeBatch`
fails the chunk. `BatchSinkWriteResult.state` is now optional. (Migration 033.)

**Claim/receipt split for exhaustion handling.** The stamp is a lease that
expires after 10 minutes; a new `exhaustion_handled` boolean is the receipt,
written only after the handler's side effect lands. A crashed claimer's stamp
expires and the job is reclaimed; the handler tolerates the rare re-run by
no-oping against terminal targets. The sweep index carries only receipt-less
failed rows. (Migration 030.)

**Release re-checks paused runs.** A deferral that parked for a paused run
records the run id; `release` then locks the run row (`FOR SHARE`, which
serializes against `resumeOperator`'s `FOR UPDATE`) and clamps `available_at`
to now if the run is no longer paused. Either the resume sees the job pending
and wakes it, or the release sees the resumed status and comes back
immediately.

**Event payloads travel with their events.** Ingestion pairs each event with
its own serialized payload instead of a sequence-keyed map, and an intra-batch
duplicate of an (invocation, sequence) pair is validated as a duplicate rather
than applied twice.

**Reference storage dropped.** `value_reference`, `output_reference`, and the
storage discriminators are gone; `batch_items.value` is NOT NULL and inline is
the only representation. Re-add by migration if large-payload offloading ever
ships. (Migration 032.)

**Smaller fixes.** The prepared-source cache refreshes recency on hit (LRU,
not FIFO). `createDatabase` records pool ceilings in a WeakMap so the worker
can warn when `concurrency × 2` exceeds the pool — reflection into Kysely's
private pool remains impossible, so the recording happens at the only point
the pool passes through our hands. Deployment runtime `maxConcurrency` and
`autoStopMinutes` are configurable, and `warmDeploymentRuntime` lets hosts pay
the cold start at deploy time. `readPage` is documented as required
side-effect free (a crash between page commit and job completion replays it).

## Consequences

- Coalescing windows admit members at constant cost; the advisory lock is held
  for three statements regardless of batch size.
- Append-only sinks flush up to 16 chunks concurrently. Stateful sinks are
  unchanged and cannot opt in accidentally.
- An exhausted job's terminal side effect is now at-least-once with a bounded
  delay after a crash (the claim interval), instead of possibly-never. The
  handler must stay idempotent — it already was.
- Resume latency for in-flight paused jobs is bounded by their current lease,
  not by the parking interval.
- Hosts that bring their own `pg.Pool` without `max` set, or a pre-built
  Kysely instance, get no pool-size warning; that remains best-effort.
