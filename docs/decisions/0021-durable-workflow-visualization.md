# 0021 — Persisted workflow visualization

- **Status:** Accepted
- **Date:** 2026-07-22
- **Updated by:** 0026 (capabilities replace category discriminators; boundary/batch scopes share one graph)

## Context

ADR 0020 introduced typed persisted definitions but intentionally deferred their
graph projection. Durable boundaries, waits, and child calls have semantics
that should remain distinct from lexical scopes and ordinary function calls,
while still rendering in the same code-first editor.

## Decision

The parser discovers exported direct
`defineWorkflow(({ defineBoundary }) => ({ steps: [...] }))` definitions. The
builder object, steps array, boundary calls, and run callbacks must be inline and
statically inspectable; the parser never executes author code. ADR 0026 replaced
the historical `durable` kind with Workflow capabilities and added
builder-scoped batch containers to the same ordered graph.

Each `defineBoundary` is a dedicated, nameless `durable-boundary` container with
vertical children and retry metadata. Ordinary calls inside remain visual
`step` detail. Returned `pause` transitions are dedicated leaves. A returned
`callWorkflow` is a workflow container that recursively inlines the child
workflow's boundaries and operations; cycle detection marks recursive calls
without expanding forever. Root edges follow the steps tuple, while inner edges
stay inside each boundary. Boundary ranges span their call and transition
ranges span their exact call so leaf selection wins.

Durable boundary and child-workflow containers are expanded by default and may
be collapsed in the read-only graph. Collapse is view state only: it filters and
re-layouts descendants without changing source, with animated size and position
transitions.

Workflow exports and boundaries use the same JSDoc contract as plain functions
workflows and steps. Boundary JSDoc immediately above `defineBoundary(...)`
supplies its display name, description, icon, and input parameter metadata. A
boundary without a display name remains visually nameless.

These graphs are exposed through the same API and editor as all Workflows. ADRs
0023-0026 subsequently added production execution through the canonical Runs
service, including boundaries, pauses, child calls, and mixed batch scopes.

## Consequences

Hosts can inspect and customize persisted semantics by node type without
confusing boundaries with lexical scopes. The graph contract and generated API
retain dedicated boundary, pause, and child-call node types, while Workflow
capabilities replace the historical third-kind discriminator. Runtime behavior
is defined by ADRs 0023-0026 rather than inferred from visualization alone.
