# 0020 — Typed persisted workflow boundaries

- **Status:** Accepted
- **Date:** 2026-07-22
- **Updated by:** 0021 (visualization), 0022 (cancellation semantics), 0026 (one Workflow model and mixed boundary/batch scopes)

## Context

Plain-code workflows remain first-class, but durable waits, retries, and child
workflows need an explicit structure that can eventually resume without
serializing a JavaScript stack. Calling this structure a step would also blur
the distinction between visual `"use step"` functions and atomic durability.

## Decision

Workflows needing persisted continuation use the dependency-light
`@catamorphic/workflow` package and
the capability-style shape
`defineWorkflow(({ defineBoundary }) => ({ steps: [...] }))`. A boundary is one
atomic retry unit; successful work inside a failed attempt is rerun. Ordinary
functions called inside it remain visual detail. `defineBoundary` is used
instead of `defineStep` to make that distinction explicit.

Each boundary receives `{ input, pause, callWorkflow }`. `pause` is the only
wait primitive: without a timeout it requires explicit resume; with one it
races explicit resume against expiry. `callWorkflow` creates a typed child call.
Both return opaque transitions that a boundary returns directly. Workflow
definitions are static and cannot be returned as transitions.

The `steps` tuple is a continuation chain: a transition resolves before its
boundary completes, and the resolved value becomes the next boundary input.
The first input and final output define the workflow signature. Values crossing
boundaries are JSON-compatible. This first change enforces the contract through
TypeScript types only; parser diagnostics, visualization, and persisted runtime
execution are follow-up work.

## Consequences

Author code gets contextual capabilities, typed child inputs/results, typed
pause outcomes, and chain mismatch diagnostics without a JSON DSL. TypeScript
cannot reject every escape, assertion, `any`, or incorrectly awaited
transition, so the coding-agent skill documents the strict form. At the time of
this decision the definitions required follow-up parser and runtime work; ADRs
0021 and 0023-0025 subsequently added visualization and Postgres-backed
production execution. ADR 0026 subsequently unified these definitions with all
Workflows and allowed `defineBoundary` and `defineBatch` in one ordered steps
tuple; persisted continuation is a capability rather than a public kind.
