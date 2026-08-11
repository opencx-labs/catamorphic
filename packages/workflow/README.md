# @catamorphic/workflow

Typed, dependency-light primitives for authoring Catamorphic workflows.

## Unified Workflows

`defineWorkflow` creates a Workflow with persisted continuation — and every
Catamorphic workflow is an exported `defineWorkflow` value. Its `steps`
tuple may mix atomic retry boundaries and paged per-item batches. The output of
each entry becomes the input of the next entry, and every value crossing an
entry boundary must be JSON-compatible. IO and business operations live in
`"use step"` functions called from boundary run bodies and batch process
callbacks.

```typescript
import {
  type BatchFailurePolicy,
  type BatchOutput,
  type BoundaryContext,
  defineBatchStep,
  defineWorkflow,
} from "@catamorphic/workflow";

interface WorkflowInput {
  accountId: string;
}

interface PreparedInput {
  accountId: string;
  pageSize: number;
}

const enrichRecords = defineBatchStep({
  batch: { maxItems: 100, maxWaitMs: 500 },
  run: async ({ items }) =>
    items.map(({ key, value }) => ({
      key,
      status: "succeeded" as const,
      result: { ...value, enriched: true },
    })),
});

const failurePolicy: BatchFailurePolicy = {
  mode: "continue",
  maxFailures: 25,
};

export const processAccount = defineWorkflow(
  ({ defineBoundary, defineBatch }) => ({
    controls: { cancel: true },
    steps: [
      defineBoundary({
        retry: { maxAttempts: 3 },
        run: async ({ input }: BoundaryContext<WorkflowInput>) => ({
          accountId: input.accountId,
          pageSize: 100,
        }),
      }),
      defineBatch({
        failurePolicy,
        source: async ({ input }: { input: PreparedInput }) => ({
          config: { accountId: input.accountId },
          source: recordsSource,
        }),
        process: async ({ item }) => enrichRecords(item),
        sink: jsonArtifactSink,
      }),
      defineBoundary({
        run: async ({
          input,
        }: BoundaryContext<BatchOutput<{ url: string }>>) => ({
          artifactUrl: input.artifact.url,
          processed: input.summary.total,
        }),
      }),
    ],
  }),
);
```

## Boundaries

`defineBoundary` creates one persisted atomic retry scope. If its callback fails,
all operations in that callback retry together. Ordinary functions called in a
boundary are not independent durability units.

Each boundary receives `{ input, pause, callWorkflow }`. `pause` and
`callWorkflow` return opaque `WorkflowTransition` values that must be returned
directly. `callWorkflow` accepts another `WorkflowDefinition` with exactly one
keyed, JSON-compatible input object; the target's input and resolved output
remain type-safe:

```typescript
defineBoundary({
  run: ({ callWorkflow }: BoundaryContext<PreparedInput>) =>
    callWorkflow(refreshAccount, { input: { accountId: "account-1" } }),
});
```

Use JSDoc immediately above a `defineBoundary(...)` or `defineBatch(...)` array
entry for `@displayname`, `@description`, `@icon`, and `@param` metadata.

## Batches

`defineBatch` is available only from the `defineWorkflow` builder context. It
defines one persisted collection scope with:

- `source`: initializes and pages a finite source with stable keyed items.
- `process`: processes each logical item durably. Calls to package-level
  `defineBatchStep` may physically coalesce compatible items here.
- `failurePolicy`: optionally continues collecting failures or stops on the
  first failure, with an optional positive-integer `maxFailures` threshold.
- `sink`: optionally writes bounded terminal chunks and finalizes one artifact.

```typescript
failurePolicy: {
  mode: "continue", // or "fail_fast"
  maxFailures: 25,
}
```

A batch never returns all item results. Without a sink its output is
`{ summary }`. With a sink its output is `{ summary, artifact }`, where the
artifact is the JSON-compatible result of `sink.finalize`.

`defineBatchStep` remains a package-level helper because its implementation may
be imported and called from `defineBatch.process`. It does not define a workflow
or collection scope.

There is no public stage construct. Boundaries and batches are ordered Workflow
scopes, while physical batch steps are an execution optimization inside
`defineBatch.process`.

Projects opt in by declaring this package. Hosts may expose a narrower surface
through their own wrapper package, for example:

```typescript
export { defineBatchStep, defineWorkflow } from "@catamorphic/workflow";
export type {
  BatchFailurePolicy,
  BatchOutput,
  BoundaryContext,
  WorkflowDefinition,
} from "@catamorphic/workflow";
```
