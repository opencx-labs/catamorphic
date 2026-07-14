# 0013 — Test and production run modes

- **Status:** Accepted (fresh production sandbox clause updated by [0014](0014-deployment-scoped-execution-runtimes.md))
- **Date:** 2026-07-12

## Context

The original run endpoint executed the invoking user's mutable working tree
while recording its `HEAD` SHA. Depending on the storage backend, the sandbox
could instead clone clean `origin/main`, so the recorded revision did not
reliably identify the code that ran. Editor runs and external production
invocations also shared one ambiguous API and one secret set.

## Decision

Runs have explicit `test` and `production` modes and separate trigger
endpoints.

- Production runs resolve and execute the canonical deployed `origin/main`
  SHA and retain it. Per [ADR 0014](0014-deployment-scoped-execution-runtimes.md),
  they use the reusable deployment-scoped runtime pinned to the complete
  immutable artifact identity, replacing this ADR's fresh-sandbox-per-run
  requirement.
- Test runs execute the invoking user's current development files plus request
  overlays in a disposable directory within their dev sandbox. They retain no
  source snapshot or SHA and are intentionally not reproducible after the
  workspace changes.
- Test and production secrets are stored independently. Existing secrets
  migrate to production; test secrets start unset.
- Both modes share one runtime harness. Parser-backed AST instrumentation wraps
  step call sites with the same node IDs shown in the workflow graph.

A hidden Git commit for every test run was rejected because test history is
diagnostic, not a deployment ledger. Running directly in the mutable project
directory was rejected because concurrent edits and workflow side effects
could corrupt or change a run in progress.

## Consequences

Production run provenance is exact, while test runs are fast and clearly
non-reproducible. Hosts must configure test secrets separately and use the
test-run endpoint for editor execution. ADR 0014 settles reusable production
runtimes; queueing, cancellation, retries, and push-based reporting remain
follow-up work.
