# Code-First Architecture

## Core Principle

TypeScript code is the single source of truth for workflow definitions. There is no JSON intermediate representation, no drag-and-drop graph builder, no visual-first editing. Code drives everything.

## How It Works

1. User writes TypeScript workflow code (or AI generates it)
2. `@catamorphic/parser` uses ts-morph to parse the AST into a `WorkflowGraph`
3. `@catamorphic/ui` renders the graph using React Flow
4. Code changes → re-parse → visual update (unidirectional)
5. Visual edits happen through AI: user describes the change → AI modifies code → re-parse

## Workflow Directives

- `"use workflow"` — marks a function as a workflow entry point
- `"use step"` — marks a function as a step

## AST-to-Graph Mapping

| TypeScript Construct | Graph Node |
|---------------------|------------|
| Function with `"use workflow"` | Trigger node |
| `await fn(args)` | Step node |
| `if (cond) { ... } else { ... }` | Condition node + branches |
| `for`/`for...of`/`while` | Loop node |
| `Promise.all([...])` | Parallel fork + join |
| `sleep(duration)` | Delay node |
| `return value` | Return node |

## Why Code-First

- Code is diffable, versionable, reviewable
- Full TypeScript type safety and IDE support
- No impedance mismatch between what you see and what runs
- AI agents are excellent at writing and modifying code
- Embedding in SaaS: host app controls the code, UI is a view layer
