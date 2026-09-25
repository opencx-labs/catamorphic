---
name: workflow-code-conventions
description: Use when changing the workflow authoring API in packages/workflow, the workflow contracts the parser and runtime enforce, or the workflow skills, examples, and fixtures shipped to agents in this repository.
---

# Workflow authoring contracts

This skill covers framework work on the authoring surface. User projects get
their instructions from the seeded skills in the table below; keep those as the
one maintained explanation per concern. For parser and graph changes, use
[code-first-architecture](../code-first-architecture/SKILL.md).

## Sources of truth

| Concern | Agent guidance | Implementation |
| --- | --- | --- |
| Definition shape, steps, triggers, connections, permissions, app contracts | [writing-workflows](../../../packages/core/src/writing-workflows-skill.ts) | [workflow.ts](../../../packages/workflow/src/workflow.ts), [permissions.ts](../../../packages/workflow/src/permissions.ts), [parser](../../../packages/parser/src/index.ts) |
| Retries, pauses, child calls, host and connection transitions | [durable-workflows](../../../packages/core/src/durable-workflows-skill.ts) | [workflow.ts](../../../packages/workflow/src/workflow.ts), [runtime](../../../packages/runtime/src/index.ts) |
| Paged items, physical batching, sinks | [batch-workflows](../../../packages/core/src/batch-workflows-skill.ts) | [batch.ts](../../../packages/workflow/src/batch.ts) |
| Source placement, deploy, enablement | [workflow-lifecycle](../../../packages/core/src/workflow-lifecycle-skill.ts) | [enablements](../../../packages/core/src/services/workflow-enablements-service.ts), [watchers](../../../packages/core/src/services/watchers-service.ts) |
| Timers, lifecycle events, attention, chat operations | [session-workflows](../../../packages/core/src/session-workflows-skill.ts) | [session-operations.ts](../../../packages/workflow/src/session-operations.ts), [schedules](../../../packages/core/src/services/schedules-service.ts) |

The public surface is whatever
[packages/workflow/src/index.ts](../../../packages/workflow/src/index.ts)
exports. `trigger` and `TriggerKinds` must stay declared in that file: projects
augment `TriggerKinds` through a generated `declare module`, which only merges
with interfaces declared in the resolved module itself.

## The model

One model ([ADR 0040](../../../docs/decisions/0040-one-workflow-model.md)):
every workflow is an exported `defineWorkflow` value and every run executes a
deployed commit. Do not add workflow kinds, a `stage` concept, or directives
other than `"use step"`.

- `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps, triggers?, connections?, permissions?, controls? }))`.
  The type checks that each step's output is the next step's input and that
  trigger payloads and output templates match the first and last steps.
- `defineBoundary({ run, retry?, rateLimits? })` is one retry unit: a failed
  attempt reruns every operation in `run`. It is not a transaction and does not
  undo external writes.
- `defineBatch({ source, process, sink? })` is paged per-item work. Package-level
  `defineBatchStep` coalesces calls and must be exported and called only inside
  `process`.
- The boundary context carries `input`, `caller`, and the transitions `pause`,
  `callWorkflow`, `host`, `documents`, and `connections`. A transition is
  returned, never awaited, one per boundary, and its result is the next step's
  input. Chats are reached with `host["catamorphic.sessions"].deliver`, by
  `sessionId` or by `key`.
- `permissions` lists concrete `thing:action` names
  ([ADR 0158](../../../docs/decisions/0158-project-permissions.md)). A run
  holds only what it declares and its owner still holds.
- Everything crossing a boundary (inputs, outputs, pause state, child IO) is
  JSON-compatible; the types reject anything else.

## Conventions for examples, seeds, and fixtures

- Step helpers take one destructured object parameter and start with
  `"use step"`. The directive is a convention for readers and agents; nothing
  enforces it, and a step is never a checkpoint.
- Every step function and every parameter has JSDoc with `@displayname`
  (AGENTS.md). Workflows and boundaries get one when they appear in the UI.
  `@description` and `@icon` are optional. Labels must describe what the code
  actually does.
- Annotate boundary callbacks with `BoundaryContext<Input>`. Destructure
  `pause` and `callWorkflow`; the parser recognizes only those bare names.
- Write IO as a statement (`await f()`, `const x = await f()`) or a returned
  call. A call nested in an object literal or argument runs but is not drawn.

```typescript
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

/**
 * @displayname Nudge stale review
 * @param sessionId - @displayname Chat | @description The review chat to nudge
 * @param updatedAt - @displayname Last update | @description ISO time of the last review activity
 */
export const nudgeStaleReview = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["sessions:write"],
  steps: [
    /** @displayname Check age */
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ sessionId: string; updatedAt: string }>) => {
        const stale = await isStale({ updatedAt: input.updatedAt, days: 2 });
        return { sessionId: input.sessionId, stale };
      },
    }),
    /** @displayname Nudge */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ sessionId: string; stale: boolean }>) =>
        input.stale
          ? host["catamorphic.sessions"].deliver({
              sessionId: input.sessionId,
              content: "This review has been quiet for two days.",
            })
          : { skipped: true },
    }),
  ],
}));

/**
 * @displayname Is stale
 * @param updatedAt - @displayname Last update | @description ISO time of the last activity
 * @param days - @displayname Days | @description Age that counts as stale
 */
async function isStale({ updatedAt, days }: { updatedAt: string; days: number }) {
  "use step";
  return Date.now() - Date.parse(updatedAt) > days * 86_400_000;
}
```

## Changing a contract

Update in the same change: the API and its types, the parser and runtime, the
seeded skill that explains it, sibling skills that mention it, and the ADR (mark
a superseded one). New chat operations also need a canvas label in the parser's
`SESSION_OPERATION_LABELS`.

Seeded guidance is assembled in [seeds.ts](../../../packages/core/src/seeds.ts).
`writing-workflows`, `durable-workflows`, and `batch-workflows` are project seeds
written under `.catamorphic/skills/`. `workflow-lifecycle` and `session-workflows`
are `HOST_SKILLS`, so they reach existing projects without rewriting files.
Skills shadow by name, project over user over host; never overwrite a project's
customized copy to refresh a default. Host discovery serves only `SKILL.md`, so
essential recipes cannot live in unshipped reference files.

## Verify

- The first `typescript` fence of writing, durable, and batch workflows is
  parsed and executed by
  [workflow-skill-recipes.test.ts](../../../packages/core/src/__tests__/workflow-skill-recipes.test.ts);
  session-workflows recipes by
  [session-workflows-skill.test.ts](../../../packages/core/src/__tests__/session-workflows-skill.test.ts).
  Extend these when a recipe changes, and test behavior, not wording: a rejected
  or timed-out approval must not call its child, a quiet monitor must not
  deliver, a reminder alerts without a model turn, a paged source replays and
  terminates.
- `bun run check` before completing, as AGENTS.md requires.
