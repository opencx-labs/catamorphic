# 0027 — Correlation keys and named external signals

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

Runs were addressable only by their surrogate id, and pauses only by `(runId, pauseId)`. Any workflow driven by external events — a marketing sequence, a dunning flow, an approval, a trial expiry — has the same shape: a long-lived journey per business entity, interrupted by events that arrive knowing the *entity*, not the run.

Nothing in the framework knew that a run was "about" anything. A host receiving `contact-42 unsubscribed` had to maintain its own contact → runId table to act on it, and every host would have rebuilt that table. Worse, a redelivered enrollment webhook had no way to avoid starting a second journey for the same contact: `execution_jobs.dedupe_key` is queue fencing scoped `run:<id>:…`, not business idempotency, and `workflow_pauses.resume_idempotency_key` only dedupes one resume call against one already-known pause.

## Decision

A run may carry a **correlation key**: a host-meaningful identity for the subject of the run, unique among non-terminal runs of the same workflow (`uq_workflow_runs_correlation_active`). One column collapses four separate features:

- **Enrollment idempotency** — a redelivered webhook cannot double-enroll. `onConflict` selects `ignore` (return the live run), `error`, or `restart` (cancel and re-enroll).
- **Signal delivery** — `pause({ signal: "reply" })` names a pause, making it addressable as `(workflow, key, signal)` via `runs.signalByKey`.
- **Interrupt** — `runs.cancelByKey` terminates the live journey wherever it sits. Opting out is *not* "resume this pause with a value"; it is "stop this journey", which run-tree cancellation already models exactly. A repeated opt-out returns null rather than erroring.
- **Operator lookup** — listing runs filtered by key shows one subject's whole history.

Terminal runs are excluded from the uniqueness index, so a subject can be re-enrolled after finishing.

**The index, not the pre-check, is the authority on conflicts.** Artifact preparation sits between the conflict check and the insert, so two simultaneous enrollments for one key can both pass the check — a window seconds wide, not microseconds. The insert therefore catches the unique violation and resolves it the same way the pre-check would: `ignore` returns the run that won, so idempotency holds under concurrency instead of surfacing a duplicate-key error. The pre-check remains as a cheap path that avoids building an artifact that is about to be discarded.

For the same reason `restart` cancels the superseded run **last**, immediately before the insert, rather than on discovering the conflict. Cancelling first means any later failure — no deployed revision, an active-run cap, a lost race — leaves the subject with no journey at all, having destroyed the one they had.

**Campaigns are modelled as run-per-entity, not one long batch run.** Rejected alternative: making `defineBatch` items individually pausable. `batch_items` already has `waiting`, `available_at`, and a per-node replay memo, so it looked close — but a continuously-enrolling batch produces a run that is *never terminal*, which breaks the assumption every run eventually reaches a terminal state that ADR 0026, the cancellation state machine (0025), and the run views all rest on. Run-per-entity keeps every run terminating and reuses child-run and cancellation machinery unchanged.

Also rejected: a first-class `Campaign`/`Sequence` concept. The framework knows about a *key*; it must never know about contacts, audiences, consent, or quiet hours. Those are host domain models.

## Consequences

Long-lived per-entity journeys become expressible without host-side bookkeeping, and the same primitives serve approvals, dunning, onboarding, and payment confirmation. `signalByKey` deliberately fails loudly (`RunSignalNotFoundError`) rather than guessing a pause when the name does not match.

The uniqueness index means concurrent enrollment for one key serialises on that key — correct, but hosts driving very high enrollment rates for a single key will see contention. Correlation keys are opt-in and production-only; test runs reject them, since a test run has no durable journey to address.

Follow-up: trigger configuration (cron/webhook, still unbuilt per 0006) should declare how to derive the correlation key from a payload plus its conflict policy, so enrollment dedupe is not reimplemented per host.
