# 0039 — Custom trigger kinds

## Status

Accepted.

## Context

Embedders have domain events — "Ticket Created", "AI Tool Call", a chat turn
settling — and want user workflows to run when those events happen, without
inventing per-host glue. Three parties are involved: the **host** knows what
events exist and what payload they carry; the **workflow author** (usually
the coding agent) decides which workflows subscribe and with what
per-workflow configuration; the **host again** needs to introspect
subscriptions (an AI tool-call kind must read each bound workflow's tool
description to hand to a model). ADR 0001 rules out registries and DSLs:
subscriptions must live in workflow source. ADR 0027 anticipated trigger
config carrying correlation-key derivation and conflict policy.

## Decision

**Hosts define trigger kinds; workflows bind to them in code; hosts fire
kinds with payloads; bindings are introspectable, statically and typed.**

- A kind is defined host-side with `defineTriggerKind` (zod payload schema,
  zod config schema, optional display metadata, allowed fire modes, optional
  `correlationKey` derivation) and registered via `createCatamorphic({
  triggerKinds })`. Core keeps a dependency-neutral `TriggerKindRuntime`
  shape so hosts may hand-roll kinds without zod.
- A workflow subscribes inside `defineWorkflow`:
  `triggers: [trigger("kind", config)]`. The kind name must be a string
  literal and the config a constant expression — the parser rejects anything
  computed, which is what makes host introspection possible without
  executing project code. One authoring surface, one extraction path
  *(wording updated by [0040](0040-one-workflow-model.md): the plain
  `"use workflow"` functions this originally excluded no longer exist)*.
- **Types cross the host→project boundary via codegen.** The registered
  kinds generate `workflows/src/catamorphic-triggers.d.ts`, a module
  augmentation of `@catamorphic/workflow`'s `TriggerKinds` interface
  (declared directly in the package entry module — augmentation only merges
  there). With no augmentation, `trigger()` is uncallable. Hosts sync it
  with `scoped.triggers.syncTypes`; generated files are projections of the
  owning side's code, regenerated on change, never hand-edited.
- **Bindings are frozen per (project, production commit)** in
  `trigger_bindings` (+ a `trigger_binding_scans` marker so binding-free
  commits don't re-parse). The first fire/list on a commit parses,
  validates every binding against the registered kinds (unknown kind or
  config schema violation fails the whole commit closed, mirroring app
  `allowed_workflows`), and records the rows. Firing — a host request-path
  operation — reads a table.
- **Firing** (`scoped.triggers.fire`, or `POST
  /projects/:id/triggers/:kind/fire`) validates the payload against the
  kind's schema, then fans out one production Run per bound workflow (the
  payload is the run input, verbatim), reusing enrollment correlation keys
  and conflict policies. `workflows: [...]` targets a subset. There is no
  new run family (ADR 0026): a trigger firing is just a way to start Runs.
- **Sync mode runs until the first wait.** The run's queue jobs are claimed
  and executed inline in the caller's request via the same fenced
  lease/heartbeat machinery workers use (`ExecutionWorkerService.
  runClaimedJob`); detaching is "stop claiming — the next job is pending
  and the polling workers own it." Detach points: pause, child workflow,
  retry backoff, rate-limit deferral, batch entry, operator pause, and a
  wall-clock `budgetMs` (default 30s, capped at 5m). The result is an
  honest union: `completed | failed | suspended { suspendedOn }`. Whether a
  sync fire settles inline is not statically knowable (pauses can be
  conditional), so the parser computes a conservative `canSuspend` per
  workflow — `false` is a hard guarantee of inline settlement, surfaced on
  bindings and workflow summaries for embedders to rely on.
- The graph's entry node was renamed `trigger` → `input` (it holds input
  parameters), freeing "trigger" for this concept. Bindings ride the input
  node; the serving layer resolves each kind's host-registered display
  metadata (label/icon/color) onto them for the UI.

## Consequences

- The desktop app registers `chat.turn-completed` (fired from the new
  `onAgentTurnSettled` core hook, with config-driven status targeting) and
  `terminal.idle` (fired on the terminal busy→idle transition), and syncs
  generated trigger types across projects at boot and after agent turns.
- The generated-types mechanism is the first instance of a broader stance:
  code is the source of truth, and codegen is how that truth scales across
  workspace boundaries (next candidates: JSON Schema for workflow
  inputs/outputs feeding run forms + MCP tools + payload validation, typed
  app-api clients for app workspaces, and generating the fastify zod graph
  schemas from parser types instead of hand-syncing).
- An embedder that changes kind schemas invalidates nothing retroactively:
  already-scanned commits keep their frozen bindings; new commits validate
  against the new schemas, and stale `catamorphic-triggers.d.ts` files are
  refreshed by the next sync.
