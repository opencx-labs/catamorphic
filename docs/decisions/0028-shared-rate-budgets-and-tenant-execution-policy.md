# 0028 — Shared rate budgets and host-owned tenant execution policy

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

`rate_reservation_buckets` (keyed `(tenant_id, global_key, partition_key)`) was already the right shape for a budget shared across every workflow in a tenant — exactly what one WhatsApp sender or one ESP account needs. But it had a single call site: `defineBatchStep` cohorts inside `defineBatch.process`. Boundaries could not reserve at all.

That left a real hole. A sequence whose first step is email (high throughput) and whose second is WhatsApp (low, shared, tiered) could not express two different limits. More seriously, any user-authored workflow could hammer a third-party API with no shared budget and get the tenant's account banned — a problem independent of campaigns, since workflow code is unrestricted (0007).

Two related gaps: `applyRetryAfter` existed but had zero production callers, so a provider's own 429 taught the system nothing; and the embedder had no way to bound what one tenant could consume, either of the queue or of a shared third-party account.

Separately, the queue claim was fair but wasteful. `claim` grouped pending jobs by tenant and took **one job per tenant per batch**, so a tenant running a large campaign was pinned to roughly `concurrency × claimLimit` jobs per poll no matter how idle the rest of the system was.

## Decision

**Rate limits are lifted from batch steps to `defineBoundary`.** Same declaration shape, same `reserve` → `ExecutionJobDeferredError` path, reused verbatim. Each boundary declares its own buckets, so differing per-step limits fall out naturally and all workflows in a tenant share one budget per `globalKey`. Reservation happens *before* the sandbox is touched, so a throttled boundary holds no compute; deferral does not consume a retry attempt, because waiting for capacity is not failure.

**Backpressure is reported explicitly, not intercepted.** `rateLimited({ retryAfterMs })` throws a `RateLimitedError` that the runtime surfaces as a new `rate_limited` terminal status (protocol v7), which the boundary handler feeds into `applyRetryAfter` for that boundary's buckets — blocking every workflow sharing the account, not just the run that hit the limit. Rejected: wrapping `fetch` to auto-detect 429s. Workflow code is arbitrary and unrestricted; implicit magic there would be unpredictable and unopt-outable.

**`tenant_execution_policies` gives the embedder the controls, and it is deliberately not reachable over HTTP** — only via the server SDK — because a tenant must not be able to raise its own limits. It carries `max_concurrent_jobs`, `max_active_runs`, `queue_weight`, `jobs_enabled`, and per-bucket `rate_limit_overrides`. Overrides can only *tighten* what the author declared: the author states what the provider accepts; the host states what this tenant is allowed. A tenant with no row is unconstrained, so adoption is incremental.

**The claim became a single set-based weighted query.** Every eligible tenant still takes a floor of one job before any tenant takes a second, preserving anti-starvation; remaining slots then backfill from the global pending set in rank order, scaled by `queue_weight` and capped by `max_concurrent_jobs`. This also removes the previous N+1 round trip (one query per tenant per claim).

> **Superseded in part by [0029](0029-queue-and-rate-correctness-at-scale.md).** This ADR claimed claim cost "no longer grows with tenant count", which was true but traded the wrong axis: ranking the whole pending set made cost grow linearly with *backlog depth* instead — 243ms per claim at 200k pending jobs. 0029 keeps the fairness semantics described here and replaces the ranking with a per-tenant LATERAL selection.

## Consequences

A tenant can now saturate idle capacity — the integration test pins this precisely: where the old claim returned exactly 1 job, the new one returns 20. Combined with run-per-entity enrollment (0027), campaign-scale fan-out becomes viable.

Hosts gain a real lever against noisy neighbours and a natural place to attach plan tiers. The cost is that queue behaviour is now policy-dependent: reading the claim query alone no longer tells you what a given tenant will get.

A `restart` enrollment is exempt from `max_active_runs`, because it replaces a run it has already cancelled and so cannot grow the active set. Charging it would let a cap lowered under existing load strand a subject — cancelled, then refused re-entry — which is the one outcome the enrollment path must never produce.

`max_active_runs` counts **root runs only**. Child runs are internal fan-out from work already admitted, and refusing one is not a safe option — a parent suspended on a child it was never allowed to create could never finish. Bounding enrollment bounds the fan-out that follows from it, so the cap is an admission control on journeys, not a hard ceiling on concurrent runs.

`max_concurrent_jobs` is deliberately a best-effort ceiling. Concurrent workers can read the same leased count and together overshoot it by up to one batch before the next poll self-corrects. Making it exact would require serializing claims per tenant — reintroducing precisely the throughput bottleneck this ADR removes. Rate *budgets* are exact (they lock their bucket rows); job *concurrency* is approximate.

Token buckets approximate calendar-window quotas (WhatsApp's 24h window, daily tiered caps) rather than modelling them exactly — refill drift means a strict daily cap is not precisely enforced. Accepted for now; a true windowed quota would need a different primitive.

`workflow_step_attempts.rate_blocked_until` / `rate_blocked_keys` make "what is parked on which bucket" queryable, but no aggregate operator view ships yet.
