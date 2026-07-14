# 0014 — Deployment-scoped execution runtimes

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

Production runs need exact provenance without paying sandbox, dependency,
transform, plugin, and Bun startup costs for every invocation. ADR 0013 required
a fresh production sandbox per run, while ADR 0004 established a sandbox per
deployment. Regular and batch workflows also need one durable invocation model.

## Decision

A production deployment artifact is immutable. Its identity includes the
project commit, resolved plugin package bytes, dependency lockfile bytes,
execution-transform version, and runtime protocol/version. Secrets are excluded;
rotation replaces or restarts the runtime generation so one generation sees a
consistent environment.

Each artifact owns one logical execution pool, initially backed by one sandbox
but able to add replicas later. The artifact is materialized once with frozen
dependencies and read-only deployed code. A long-lived Bun HTTP supervisor in
each sandbox accepts work through provider-private, authenticated transport and
dispatches invocations to a bounded pool of Bun Worker threads. Workers, not OS
child processes, provide per-invocation module caches, environment copies, and
writable directories; the sandbox remains the security boundary.

Provider URLs, tunnel credentials, and process details stay inside provider
plugins. Cloudflare remains the priority implementation and alternate providers
implement the same lifecycle and invocation contract, reinforcing ADR 0004.

Regular and batch production work share one invocation protocol and incremental,
sequenced reporting. Postgres is the durable authority for queue state, leases,
attempts, cancellation, checkpoints, and outcomes; supervisors are replaceable
compute. Test mode retains ADR 0013's per-user mutable dev files, test secrets,
null-SHA provenance, and disposable run directories, never a production pool.

This updates only ADR 0013's fresh-production-sandbox requirement: production
runs use the deployment-scoped pool pinned to their immutable artifact.

## Consequences

Production provenance remains exact while warm runtimes amortize setup cost.
Invocations from different artifacts or trust boundaries never share a pool.
Worker failure, timeout, or cancellation requires worker replacement;
supervisor state is disposable and recovery follows Postgres. Pool
reconciliation, health checks, idle reclamation, and artifact retention become
provider-neutral runtime responsibilities.
