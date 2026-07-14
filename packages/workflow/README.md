# @catamorphic/workflow

Typed, dependency-light primitives for authoring Catamorphic workflows.

```typescript
import {
  defineBatchStep,
  defineBatchWorkflow,
  skipBatchItem,
} from "@catamorphic/workflow";
```

Projects opt in by declaring the package. Catamorphic does not add it to blank
or regular projects.

SaaS hosts may expose a narrower authoring surface through their own package:

```typescript
export {
  defineBatchStep,
  defineBatchWorkflow,
} from "@catamorphic/workflow";
```

Workflow source can then import only the primitives selected by the host.
