# 0017 — Public workflow authoring package

- **Status:** Accepted
- **Date:** 2026-07-13
- **Expanded by:** 0020 (boundary authoring), 0026 (unified Workflow with boundary and batch scopes)

## Context

The original collection-processing design needed typed source, physical-step,
sink, outcome, and skip helpers. Keeping those helpers in the private
execution runtime couples author code to supervisor internals; copying a local
`src/batch.ts` into each project lets the authoring and execution contracts
drift. Hosts also need to expose a curated wrapper without forcing Catamorphic's
full authoring surface into every project.

## Decision

`@catamorphic/workflow` is the public, dependency-light package for code that
authors workflows. It owns batch source, step, sink, keyed-outcome, policy, and
workflow definition contracts. `@catamorphic/runtime` remains private execution
infrastructure and may depend on authoring types, but the authoring package
never depends on the runtime, parser, core, or sandbox.

Projects opt in with an explicit dependency. Catamorphic templates add it only
when their source imports it; blank and regular templates remain dependency
free. A SaaS may instead publish a wrapper that depends on this package and
re-exports only its chosen primitives.

Until the package is available from a registry, a host may stage its exact
installed package artifact only when the project declares the matching exact
version. Different versions use normal package resolution and are never
silently replaced. The staged bytes participate in deployment artifact
identity.

The package is named `@catamorphic/workflow`, not `workflow-prelude`, because
its APIs are explicit imports rather than ambient language primitives.

## Consequences

Workflow code has one versioned authoring contract and no generated helper
copy. Hosts retain control through wrapper packages, while templates can use
the direct package without making it mandatory for unrelated projects. The
local fallback requires an unlocked project; locked projects must resolve the
declared package normally so lockfile reproducibility remains intact.

ADR 0026 later replaced the original top-level constructor with builder-scoped
`defineBatch` inside `defineWorkflow`. Package-level `defineBatchStep` and
`skipBatchItem` remain part of this authoring package.
