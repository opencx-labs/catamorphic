---
name: code-first-architecture
description: Use when changing how Catamorphic reads workflow source, including the parser, the WorkflowGraph and its projections (schemas, triggers, connections, permissions), canvas rendering, or anything that could make a derived artifact compete with the TypeScript source.
---

# Code-first architecture

Workflow TypeScript is the only definition. Everything else is derived from it
statically and can be regenerated at any time. Keep it that way:

- No JSON intermediate format, workflow DSL, or graph that is stored and edited
  as the source. The canvas is a projection; a change made from the canvas goes
  through code, written by an agent or in the editor.
- The parser never executes project code. Hosts introspect graphs, triggers,
  connections, and permissions without a sandbox, which is why those values
  must be inline constants.
- Authorization is not part of a definition. A workflow declares what it needs
  (`connections`, `permissions`, `triggers`). Committed `.catamorphic/roles/*.json`
  files and server-side workflow enablements decide who may reach or turn it on
  ([ADR 0158](../../../docs/decisions/0158-project-permissions.md)). Never fold
  either into the graph.

For the authoring API and its guidance, use
[workflow-code-conventions](../workflow-code-conventions/SKILL.md).

## Pipeline

1. Source lives in `.catamorphic/workflows/src/` of a project
   ([ADR 0142](../../../docs/decisions/0142-contained-project-workspace.md)).
2. `@catamorphic/parser` (ts-morph) turns it into a `WorkflowGraph`: nodes and
   edges, an execution descriptor, `inputSchema`/`outputSchema`, `triggers`,
   `connections`, `permissions`, and `canSuspend`
   ([types](../../../packages/parser/src/types.ts)).
3. `layoutGraph` positions it and `@catamorphic/ui` renders it with React Flow.
4. The same package drives execution (`prepareWorkflowExecution`), generated app
   API types ([ADR 0041](../../../docs/decisions/0041-generated-projections.md)),
   and `checkProject`, the engine behind each project's
   `bun run --cwd .catamorphic check`.

Code change, re-parse, re-render. The direction never reverses.

## What the parser accepts

A workflow is an exported variable initialized by a direct `defineWorkflow` call
whose builder returns an object literal with an inline `steps` array of direct
`defineBoundary`/`defineBatch` calls with inline callbacks. `triggers` must be
inline `trigger("kind", constant)` calls; `connections` and `permissions` must be
constant arrays, and permissions must be concrete `thing:action` names (wildcards
belong to roles). Anything else is a parse error that names the workflow and
position; users see these through `check`, so keep them specific.

| Source | Graph node |
| --- | --- |
| The exported `defineWorkflow` declaration | `input` (JSDoc label, `@param` metadata, trigger bindings) |
| `defineBoundary({ run })` | `durable-boundary` container |
| `defineBatch({ source, process, sink? })` | `batch` container with `source`, `sink`, and an "Item result" `return` |
| Call statement, `const x = await call()`, or a returned call | `step` (label from the callee's JSDoc `@displayname`) |
| Returned `context.host[...]` or `context.connections.*` call | `step` with a readable host label |
| `if` / `else if` / `else` | `if-block` with `branch` children |
| Returned `cond ? a : b` | `if-block`; each arm draws its step or transition, a value-only else draws nothing |
| `for`, `for...of`, `for...in`, `while` | `loop-block` |
| `await Promise.all([...])` | `parallel-block` |
| Async IIFE or bare `{ }` block | `scope-block` |
| Returned `pause(...)` | `pause` |
| Returned `callWorkflow(child, { input })` | `call-workflow`, with the child's graph nested |

Calls nested inside another expression (an object literal, an argument) are not
drawn. Write IO as a statement or a returned call so it appears on the canvas.
`pause` and `callWorkflow` are recognized destructured (`pause(...)`) or read
from a named context (`context.pause(...)`); the execution transform uses the
same rule to hand a child call its target.
Exported `defineBatchStep` calls are valid only inside `process` and render as
steps with physical batching metadata, never as separate workflow scopes.

Detailed container, edge, and layout rules live in
[parser-conventions](../../../.cursor/rules/parser-conventions.mdc) and
[graph-design](../../../.cursor/rules/graph-design.mdc).

## Changing the parser or graph

- Add a construct only when it expresses an existing runtime semantic. The
  graph must not promise behavior the runtime does not have, and the runtime
  must not gain behavior the graph cannot show.
- Canvas nodes show an icon and a human label, never code. Put expressions and
  policies in the inspector's technical details.
- Update together: parser tests in `packages/parser/src/__tests__/`, the
  execution transform when semantics change, the `.cursor/rules` parser and
  graph docs, and any seeded skill example the change affects.
