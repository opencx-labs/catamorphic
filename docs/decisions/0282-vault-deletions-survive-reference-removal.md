# 0282 - Vault deletions survive reference removal

- **Status:** Proposed
- **Date:** 2026-10-25

This proposal is deliberately deferred. The secret-management security PR does
not implement it or change the existing deletion lifecycle.

## Context

Secret replacement and removal can swallow a failed vault deletion after the
database reference is gone. Project deletion cascades away references without
deleting their vault records. Company credentials can therefore remain encrypted
and recoverable after the product reports them removed.

## Decision

Keep pending vault deletions in the existing Postgres authority. Removing or
replacing a reference enqueues its tenant and opaque ref in the same transaction.
Project and session cascades enqueue all affected refs before deleting them.
The existing execution worker drains bounded batches with `SKIP LOCKED`, deleting
the vault object idempotently and acknowledging the row only after success.
Failures remain retryable across process restarts and replicas.

Immediate cleanup may still attempt the same deletion, but it never substitutes
for the durable receipt. No credential value enters the queue, logs or errors.
This does not revoke an upstream API key; provider revocation remains the
connection service's responsibility. Interrupted vault writes before any
reference is stored require a separate storage-inventory reconciliation policy.

## Consequences

This adds one internal database queue and worker maintenance action, with no new
infrastructure or public secret format. Operators can inspect pending counts
and retry failures. Queue records outlive deleted projects and tenants until
cleanup succeeds.
