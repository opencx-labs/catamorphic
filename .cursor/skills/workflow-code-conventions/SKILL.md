# Workflow Code Conventions

## Workflow Functions

```typescript
/**
 * @displayname Human-Readable Name
 * @description What this workflow does
 */
export async function workflowName({ param1, param2 }: { param1: Type1; param2: Type2 }) {
  "use workflow";
  // workflow body
}
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

## Batch Workflows

Batch workflows import their authoring primitives from the project's
established SaaS wrapper, or directly from `@catamorphic/workflow` when no
wrapper exists:

```typescript
import {
  defineBatchStep,
  defineBatchWorkflow,
  skipBatchItem,
} from "@catamorphic/workflow";
```

Do not create project-local copies of these primitives.

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
- `sleep("7 days")` — delay/wait
- `return { ... }` — workflow output

## Rules

- One `"use workflow"` per file
- Steps must have `"use step"` directive
- All function parameters must be destructured objects
- Use JSDoc for all UI-facing metadata
