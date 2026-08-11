# 0041 - Generated projections: schemas and types derived from code

- **Status**: accepted
- **Date**: 2026-08-11

## Context

Code is the source of truth (ADR 0001), but several consumers need what the
code *means* in another form: run forms and MCP tools need input shapes, the
trigger surface needs introspectable bindings, app authors need typed
clients, and workflow authors need the host's trigger kinds as types. Each
of these was previously either hand-maintained (the `contracts/` package,
the fastify graph schemas), string-typed (`ParameterInfo.type` as source
text), or absent (no run-input validation, MCP tools with an untyped
`input` envelope).

## Decision

A **projection** is a machine-derived artifact whose single source of truth
is code someone owns; it is regenerated on change, drift-checked, and never
hand-edited. Three ship now:

1. **Workflow IO JSON Schemas** (`packages/parser/src/schema-extract.ts`).
   The parse project injects a type-surface stub for `@catamorphic/workflow`
   and a `paths` mapping for `@project/contracts`, so `BoundaryContext<T>`
   arguments and contracts imports resolve in the type checker (previously
   they degraded to `any`). Each workflow graph carries `inputSchema` (first
   step's input type) and `outputSchema` (last step's resolved output, with
   `Promise`/`WorkflowTransition` unwrapped — a terminal `pause(...)` yields
   the `PauseResult` union); each `ParameterInfo` carries a per-property
   `schema`. Anything the emitter cannot understand degrades to `{}` —
   permissive, never rejecting. Consumers: run-input validation at
   `triggerProduction` (path-level errors at the door, via the matching
   hand-rolled validator subset in `json-schema-validate.ts`), the run
   form's enum selects, MCP workflow tools (real `inputSchema`, frozen per
   app version in `app_versions.workflow_shapes`), and trigger bindings
   (`trigger_bindings.input_schema`/`output_schema`, served on
   `TriggerBindingInfo` — tool-definition-ready).

2. **Trigger-kind types** (`workflows/src/catamorphic-triggers.d.ts`, ADR
   0039) — host zod schemas → module augmentation of
   `@catamorphic/workflow`'s `TriggerKinds`.

3. **Typed app-api clients** (`apps/<name>/src/catamorphic-app-api.d.ts`).
   From the parsed `app-api.ts` surface joined with the workflows' IO
   schemas, `renderAppApiTypesModule` emits a `ProjectAppApi` interface of
   `Workflow<{ input; output }>` entries for `createClient<ProjectAppApi>()`.
   `contracts/` remains for genuinely shared domain types; the callable
   surface no longer needs hand-mirroring there.

`scoped.triggers.syncTypes` writes all file projections into the dev tree
in one drift-checked commit. A fourth, degenerate projection guards the
serving layer: a compile-time assertion test in `@catamorphic/fastify-plugin`
(`parser-schema-sync.test.ts`) fails `typecheck` if the hand-written zod
graph schemas drift from the parser types.

## Consequences

- The extractor and validator deliberately speak the same JSON Schema
  subset (`type/object/properties/required/additionalProperties/items/
  enum/const/anyOf`); widening one means widening the other.
- The workflow type-surface stub in the parser is a maintained copy of
  `@catamorphic/workflow`'s inference-bearing types (validation
  intersections omitted). It changes only when the authoring surface does;
  drift shows up as extraction degrading to permissive schemas, never as
  wrong rejections.
- Generated files live inside workspaces' `src` so no tsconfig changes are
  needed, and app-scoped files never perturb the execution artifact digest
  (`executionFiles` strips `apps/**`).
