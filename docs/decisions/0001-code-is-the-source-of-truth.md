# 0001 — Code is the source of truth for workflows and apps

- **Status:** Accepted
- **Date:** 2026-07-02
- **Expanded by:** 0015 (historical collection processing), 0020 (boundary definitions), 0026 (unified Workflow capabilities)

## Context

Workflow builders traditionally store workflows as JSON or a proprietary DSL and render code (if at all) as an export format. That approach caps expressiveness, ages badly, and locks users in. Catamorphic's goal is for non-technical users to build automations with AI while technical users retain full control.

## Decision

Workflows and apps are **TypeScript code**, and the code is strictly the source
of truth. We will never invent a DSL or JSON format for storing workflow logic.
A *project* is a git repository of TypeScript. Workflows are either exported
async functions with the exact `"use workflow"` directive (steps use exact
`"use step"`) or exported `defineWorkflow(...)` definitions with statically
inspectable boundary/batch scopes. Both are discovered by parsing; there is no
registry file or workflow table.

The visual graph is a **projection** of the code: `@catamorphic/parser` (ts-morph) converts the AST into a `WorkflowGraph` rendered by React Flow. Edits flow through code (human or AI-authored), never through graph mutations serialized to a side format.

Workflow code must stay simple — a constrained, conventional subset of TypeScript (single destructured object parameters, JSDoc display metadata) — so that AI agents and humans can write and edit it reliably and the parser can render it intuitively.

## Consequences

- No lock-in format; users can take their project repo anywhere.
- AI agents work in their native medium (code), not a bespoke schema.
- The parser is a load-bearing component: language constructs must be supported deliberately (see `parser-conventions.mdc`).
- The canvas is read-only today; bidirectional (graph → code) editing must be implemented as code transformations.
