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

## Availability, connections, and unattended execution

Workflow code and access policy have separate jobs:

- The exported workflow name is the value a committed `roles/<slug>.json`
  lists under `workflows`. A member cannot see or run it without that grant.
- The workflow's top-level `connections` array declares provider-neutral
  aliases, member/service principal policy, and required actions. An MCP
  connection satisfies the requirement when it exposes those actions.
- The role must separately grant each connection alias under `connections`
  and an allowed Environment under `environments`.
- Trigger declarations are inert until each member explicitly chooses
  **Automate** then **Enable for me** and reviews the pinned revision,
  Environment, connections, actions, and triggers. Authentication may finish
  that user-initiated enablement, but connecting an account alone never opts a
  user into workflows.

Use `trigger("schedule", { cron, timezone })` for cron schedules. Use
`context.host["catamorphic.sessions"].wake(...)` when a member-owned workflow
should create or reuse a stable project-agent session, queue a turn, and
surface the settled result in desktop and PWA:

```typescript
return context.host["catamorphic.sessions"].wake({
  key: "daily-inbox-summary",
  agentSlug: "inbox-assistant",
  title: "Daily inbox summary",
  content: "Read my connected inbox and summarize what needs attention.",
  notification: { title: "Your inbox summary is ready" },
});
```

The role must grant both the workflow and `inbox-assistant`. The stable key is
scoped to the workflow, retries are idempotent, and later schedule occurrences
reuse the same conversation. `wake` is member-only because service enablements
have no personal recipient. Use `catamorphic.sessions.deliver` when an exact
session id is already available.

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
