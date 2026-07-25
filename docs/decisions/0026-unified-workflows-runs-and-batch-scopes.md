# 0026 — Unified workflows, runs, and batch scopes

- **Status:** Accepted
- **Date:** 2026-07-25
- **Supersedes:** 0015
- **Expands:** 0017, 0020, 0021, 0023

## Context

Plain functions, persisted definitions, and collection definitions currently
appear as three workflow kinds with separate constructors, run tables, services, routes,
SDK hooks, and UI. This exposes execution mechanics as product concepts and
prevents one Workflow from naturally mixing retry scopes with bounded
collection processing.

## Decision

There is one public Workflow and one public Run model. Plain exported
`"use workflow"` functions are workflows without persisted continuation
capabilities. `defineWorkflow` creates a Workflow with persisted continuation
whose ordered `steps`
may contain builder-scoped `defineBoundary` retry scopes and `defineBatch`
collection scopes. Package-level `defineBatchStep` remains the optional physical
coalescing primitive used inside `defineBatch.process`. The old top-level
collection constructor is removed.

A boundary is one atomic persisted retry unit: ordinary operations in its callback
retry together. A batch scope owns finite paged source, per-item replay and
retry, physical batching, and optional bounded sink finalization. “Stage” may be
used internally for execution-plan entries but is not an authoring, SDK, API, or
UI concept.

Every invocation has one canonical `workflow_runs` row. Strategy-specific state
lives in extension tables keyed by run and internal step attempt. One RunsService,
HTTP route family, identity-bound SDK resource, generated client model, React
hook family, and Runs UI expose capabilities rather than a mutually exclusive
workflow-kind discriminator. Internal queue and runtime work kinds remain
private dispatch details. Public SDK methods use one keyed object parameter.
Public Workflow DTOs expose graph, files, and capabilities but not parser
execution descriptors; embedders that explicitly use `CatamorphicCore` retain
access to those internal execution plans. Workflow reads, including list, accept
an optional git ref and parse all source from that ref.

Run controls are capability-checked operations. Pause and resume return a typed
capability error when their current capability is unavailable. Repeating pause
on an operator-paused Run or resume on its already-running Batch scope is
idempotent; unrelated phases and terminal states are not silent successes.

## Consequences

Authors can combine boundaries and batch scopes in one typed workflow, while
hosts reason only about workflows, runs, and supported controls. The execution
coordinator must advance heterogeneous persisted steps and scope all batch item
state to the active run step. This is a greenfield breaking cleanup: old batch
constructors, routes, services, hooks, tables, and kind fields are removed
without aliases or historical-run migration.
