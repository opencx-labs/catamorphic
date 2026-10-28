# 0291: Named signals buffer within one run generation

- **Status:** Accepted (amends 0027)
- **Date:** 2026-10-28

## Context

A callback can arrive before a workflow returns its named pause. Requiring the
sender to catch that instant loses valid events. Matching only a correlation
key also lets a late callback reach a replacement run of the same workflow.

## Decision

Extend the existing `runs.signalByKey` and named `pause` path with a durable
inbox for one existing run generation. Senders supply the enrollment's `runId`
alongside project, workflow and correlation key. The run must match all four;
new signals require an active run and current `runs:write` authority. Missing,
terminal and canceling runs never accept new events. No signal creates a run or
moves to a future generation. Exact pause-id resume keeps its targeted semantics.

The run row serializes send, pause, timeout and termination. The oldest pending
signal with a matching name resolves the pause in the same transaction that
persists it and creates its continuation. An already expired pause times out
first and leaves the signal available for a later matching pause. Signals do not
resume unnamed pauses or pauses with another name. Accepting an event does not
promise that the workflow will ever open a matching pause.

A required idempotency key is unique within the run, across signal names. Same
name and canonical JSON value return the same receipt's current state; different
content conflicts. Receipts distinguish `buffered`, `resumed` (with pause id)
and `discarded`. Each JSON value is at most 64 KiB; each run has at most 256
pending signals and 1,024 total signal receipts. Limits reject atomically. The
lifetime receipt limit bounds deduplication storage without unsafe expiry.

Consumption clears the inbox value. Cancellation or terminal status discards all
remaining values in the same database transaction, retaining bounded receipts
and content hashes until ordinary run retention deletes them by cascade. A
retry of an existing receipt is readable after termination but still requires
current authority. No native cloud integration or second workflow model is added.

## Consequences

Callbacks can safely precede waits, replicas race through one Postgres claim,
and restarts cannot inherit old callbacks. Senders must carry the generation id
from enrollment; correlation keys alone cannot prove which generation produced
a previously unseen event. Long-lived event streams should split runs or use an
application-owned ledger rather than an unbounded workflow inbox. Signal
acceptance adds no execution authority; capability calls retain their own
authorization checks.
