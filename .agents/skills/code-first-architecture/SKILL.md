---
name: code-first-architecture
description: Use when designing or changing Catamorphic workflow authoring, AST parsing, graph rendering, visual editing, or the boundary between workflow code and generated representations.
---

# Code-First Architecture

## Core Principle

TypeScript code is the single source of truth for workflow definitions. There is no JSON intermediate representation, no drag-and-drop graph builder, no visual-first editing. Code drives everything.

## How It Works

1. User writes TypeScript workflow code (or AI generates it)
2. `@catamorphic/parser` uses ts-morph to parse the AST into a `WorkflowGraph`
3. `@catamorphic/ui` renders the graph using React Flow
4. Code changes → re-parse → visual update (unidirectional)
5. Visual edits happen through AI: user describes the change → AI modifies code → re-parse

## Workflow Authoring

- Every Workflow is an exported
  `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
  value with persisted continuation.
- `"use step"` marks a visual step function holding IO, called from boundary
  run bodies and batch process callbacks.
- `defineBoundary` is an atomic retry scope whose callback operations retry
  together.
- `defineBatch` is finite paged per-item processing with an optional sink.
- Package-level `defineBatchStep` physically coalesces compatible calls only
  inside `defineBatch.process`.

There is no public stage construct. All definitions remain exported TypeScript
and the parser never executes author code.

Top-level `connections` and inline `triggers` are also authored in the
TypeScript definition and parsed as constant metadata. They describe what a
workflow needs and what can wake it, not who is authorized. Committed
`roles/*.json` grant workflow, agent, Environment, and connection refs;
server-owned workflow enablements record each member's consent to an exact
deployment. Do not encode either policy layer into a generated graph or a new
workflow DSL.

`context.host["catamorphic.sessions"].wake(...)` is a durable host transition,
not a step-side effect. Its stable key selects a reusable member session; the
agent's work proceeds through the normal session queue after the workflow call
returns.

## AST-to-Graph Mapping

| TypeScript Construct | Graph Node |
|---------------------|------------|
| `defineWorkflow` export's input parameters | Input node |
| `await fn(args)` | Step node |
| `if (cond) { ... } else { ... }` | Condition node + branches |
| `for`/`for...of`/`while` | Loop node |
| `Promise.all([...])` | Parallel fork + join |
| `sleep(duration)` | Delay node |
| `return value` | Return node |
| `defineBoundary({ run })` | Boundary container |
| `defineBatch({ source, process, sink? })` | Batch container with source/process/sink detail |
| returned `pause(...)` | Pause node |
| returned `callWorkflow(...)` | Child Workflow node |

## Why Code-First

- Code is diffable, versionable, reviewable
- Full TypeScript type safety and IDE support
- The graph faithfully projects supported source semantics and exposes Workflow
  capabilities rather than kind discriminators.
- Persisted boundaries, pauses, child calls, batch progress, retries, and
  cancellation execute through the canonical Runs service and Postgres state.
- AI agents are excellent at writing and modifying code
- Embedding in SaaS: host app controls the code, UI is a view layer
