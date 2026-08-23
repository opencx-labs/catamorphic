---
name: workflow-code-conventions
description: Use when creating, reviewing, or changing Catamorphic workflow definitions, step functions, boundaries, batches, pauses, child workflows, or workflow authoring metadata.
---

# Workflow Code Conventions

## Workflow Definitions

Every workflow is an exported `defineWorkflow` value.

```typescript
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

/**
 * @displayname Human-Readable Name
 * @description What this workflow does
 */
export const workflowName = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ param1: Type1 }>) => {
        // orchestration body: awaited step calls, if/else, loops
      },
    }),
  ],
}));
```

## Step Functions

All steps use a single destructured object parameter. Never positional params.

```typescript
/**
 * @displayname Step Display Name
 * @icon icon-name
 * @param propName - @displayname Display Name | @description Property description
 */
async function stepName({ propName }: { propName: Type }) {
  "use step";
  // step body
}
```

Steps are the home of IO and business operations, called from boundary run
bodies and batch process callbacks. Boundaries persist continuation; add more
boundaries for explicit retry, pause, or child-call scopes and `defineBatch`
for paged collections.

## Persisted Workflow Scopes

Import authoring primitives from the project's established SaaS wrapper, or
directly from `@catamorphic/workflow` when no wrapper exists. Do not create
project-local copies.

```typescript
import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

export const approveOrder = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /**
     * @displayname Request Approval
     * @description Create and wait for an approval request
     * @icon badge-check
     * @param orderId - @displayname Order ID | @description Order to approve
     */
    defineBoundary({
      retry: { maxAttempts: 3 },
      run: async ({ input }: BoundaryContext<{ orderId: string }>) => ({
        orderId: input.orderId,
        requestId: `request-${input.orderId}`,
      }),
    }),
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<{
        orderId: string;
        requestId: string;
      }>) => pause<{ approved: boolean }>({ timeout: "24h" }),
    }),
  ],
}));
```

- `defineBoundary` exists only on the `defineWorkflow` builder context.
- `defineBatch` also exists only on that builder context. It owns finite paged
  per-item processing and an optional sink.
- `defineBatchStep` remains package-level so compatible calls may be physically
  coalesced inside `defineBatch.process`. Never call it outside `process`, and
  do not treat it as a Workflow or persisted scope.
- `pause` and `callWorkflow` exist only on `BoundaryContext`.
- Do not import `pause` or `callWorkflow` from `@catamorphic/workflow` and do
  not call them as globals. Destructure the capability used by each boundary,
  for example `({ input, pause }: BoundaryContext<Input>)`.
- Return transitions directly; never `await pause(...)` or `await
  callWorkflow(...)`.
- Return `callWorkflow(child, { input })`, never a workflow definition.
- Annotate every callback with `BoundaryContext<Input>`.
- Inputs, outputs, pause state/value, and child inputs/outputs are
  JSON-compatible.
- A boundary is one atomic retry unit. Ordinary `"use step"` functions called
  inside it are visual detail rather than separate persisted checkpoints.
- Workflows, boundaries, and batch scopes use the same JSDoc attributes:
  `@displayname`, `@description`, `@icon`, and `@param`. Place scope JSDoc
  immediately above its `defineBoundary(...)` or `defineBatch(...)` array entry.
- `controls: { cancel: true }` declares a host-issued terminal cancel control.
  Never invent `BoundaryContext.cancel()` or add cancellation to `PauseResult`.

Strict `defineWorkflow` definitions are statically visualizable and execute one
boundary or batch scope at a time against an immutable production deployment.
Postgres persists retries, pauses, child links, collection items, continuation
state, and cancellation between invocations.

## JSDoc Tags

- `@displayname` — label shown in the UI node
- `@description` — tooltip/detail text
- `@icon` — icon identifier for the node
- `@param name - @displayname X | @description Y` — per-property metadata

## Supported Constructs

- `await fn(args)` — sequential step call
- `if (condition) { ... } else { ... }` — conditional branching
- `for (const x of items) { ... }` — loop iteration
- `Promise.all([fn1(), fn2()])` — parallel execution
- durable waits — a boundary returns `pause(...)`
- `return { ... }` — workflow output

## Rules

- Use one public Workflow model; never add a kind field or a public stage.
- Every workflow is an exported `defineWorkflow` value; there is no
  `"use workflow"` directive.
- Steps must have `"use step"` directive
- All function parameters must be destructured objects
- Use JSDoc for all UI-facing metadata
