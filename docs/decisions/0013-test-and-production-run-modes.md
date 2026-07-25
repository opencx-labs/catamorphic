# 0013 — Test and production run modes

- **Status:** Accepted (fresh production sandbox clause updated by [0014](0014-deployment-scoped-execution-runtimes.md))
- **Date:** 2026-07-12
- **Updated by:** 0014 (deployment runtimes), 0026 (one Run API/model)

## Context

The original run endpoint executed the invoking user's mutable working tree
while recording its `HEAD` SHA. Depending on the storage backend, the sandbox
could instead clone clean `origin/main`, so the recorded revision did not
reliably identify the code that ran. Editor runs and external production
invocations also shared one ambiguous API and one secret set.

## Decision

Runs have explicit `test` and `production` modes within one canonical Run model
and route/hook family. The modes retain separate trigger operations because
their source and provenance semantics differ.

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

Production Run provenance is exact, while test Runs are fast and clearly
non-reproducible. Hosts configure test secrets separately and use the test-mode
trigger for editor execution of plain Workflow functions. ADRs 0014, 0016, and
0023-0026 subsequently implemented reusable production runtimes, queueing,
retries, persisted continuation, cancellation, and one Runs surface.
