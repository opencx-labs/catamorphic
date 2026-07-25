# 0015 — First-class batch workflows

- **Status:** Superseded by 0026
- **Date:** 2026-07-12
- **Superseded by:** [0026](0026-unified-workflows-runs-and-batch-scopes.md), which retains the finite source, per-item replay, physical batching, and sink semantics inside builder-scoped `defineBatch`

## Context

Large finite datasets need bounded fan-out, resumability, per-item history,
efficient bulk operations, and restartable result collection. Treating the
entire dataset as one regular run would create unbounded memory and state;
creating a full workflow-run row per item would make high-cardinality batches
needlessly heavy. Batch behavior must remain code-first, embeddable, and shared
with regular execution where semantics match.

## Decision

Batch workflows are a first-class workflow type authored with the typed,
statically inspectable `defineBatchWorkflow` helper from
`@catamorphic/workflow` (see ADR 0017):

```typescript
export const analyzeFeedback = defineBatchWorkflow({
  source: ({ input }) => seededFeedbackSource({ since: input.since }),
  process: async ({ item }) => classifyFeedback({ feedback: item }),
  sink: csvSink({ fileName: "feedback-analysis.csv" }),
});
```

The export name remains workflow identity; TypeScript remains the only source
of truth. Regular `"use workflow"` functions keep their existing semantics.

- A batch launch traverses one finite, resumable source. Stable item keys,
  persisted snapshots/cursors, deduplication, bounded pages, and backpressure
  make page retries safe; infinite streams are not batch sources.
- Postgres in the host-provided schema supplies the `SKIP LOCKED` queue and is
  authoritative for batch, source, item, invocation, outcome, and sink state.
  Lightweight batch-item records are used instead of child workflow-run rows.
- Batching is per step. Compatible items may form an immutable physical batch;
  the implementation returns exactly one keyed success or classified error per
  input. Outcomes persist independently, and retries include only unresolved
  items even when they form a different physical batch.
- Resume uses deterministic replay from `process` start with stable
  item/node/occurrence identity; completed step outputs are returned from
  Postgres. External effects remain at-least-once and require stable idempotency
  keys or reconciliation.
- Optional sinks consume bounded terminal chunks using deterministic chunk keys,
  persist acknowledgements, retry only unacknowledged chunks, and finalize
  artifact references without loading all results into memory.

Batch and regular production work use ADR 0014's shared deployment runtime and
invocation protocol. Core contracts contain no host-specific business concepts;
hosts inject tenant-scoped sources, sinks, storage, and credentials. The
playground provides a credential-free Customer Feedback Analysis reference that
demonstrates paged sourcing, item steps, batch classification, an idempotent
summary sink, and artifact finalization. Engine integration tests cover partial
batch retries and deterministic replay.

## Consequences

Batch workflows can scale and resume per item without a giant run or a second
DSL. The engine must add source/sink contracts, parser nodes, durable replay,
batch coordination, retention, fairness, and keyed-outcome validation. Source
page size, queue claims, step batch limits, runtime concurrency, and sink chunk
size remain independent controls.
