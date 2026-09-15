---
name: workflow-code-conventions
description: Change or review Catamorphic workflow authoring contracts, examples, and agent guidance in the framework repository.
---

# Workflow authoring contracts

Use this repository skill when changing workflow definitions, parser/runtime
contracts, or the guidance shipped to agents. For user-project authoring, the
shipped skills below are the maintained instructions. Read only what the change
touches; keep host-specific doctrine separate from framework mechanics.

## Sources of truth

| Concern | Agent guidance | Implementation |
| --- | --- | --- |
| Source location, ownership, deploy/enable flow | [workflow-lifecycle](../../../packages/core/src/workflow-lifecycle-skill.ts) | [Watcher service](../../../packages/core/src/services/watchers-service.ts), [enablement service](../../../packages/core/src/services/workflow-enablements-service.ts) |
| Definition shape, steps, triggers, app contracts | [writing-workflows](../../../packages/core/src/writing-workflows-skill.ts) | [Workflow API](../../../packages/workflow/src/workflow.ts), [parser](../../../packages/parser/src/index.ts) |
| Retries, pauses, child/host transitions | [durable-workflows](../../../packages/core/src/durable-workflows-skill.ts) | [Workflow API](../../../packages/workflow/src/workflow.ts), [runtime](../../../packages/runtime/src/index.ts) |
| Paged items, physical batching, sinks | [batch-workflows](../../../packages/core/src/batch-workflows-skill.ts) | [Batch API](../../../packages/workflow/src/batch.ts) |
| Timers, lifecycle events, attention, session actions | [session-workflows](../../../packages/core/src/session-workflows-skill.ts) | [Session operations](../../../packages/workflow/src/session-operations.ts), [schedule service](../../../packages/core/src/services/schedules-service.ts) |

## Preserve the shared model

- An exported direct `defineWorkflow` call returns an inline builder object with
  inline `steps`. `defineBoundary` and `defineBatch` are builder capabilities;
  `defineBatchStep` is a package export used only inside batch processing.
- Definitions, trigger bindings, and connection requirements are statically
  inspectable TypeScript. Never introduce a parallel workflow DSL or make a
  generated graph the source of truth. For AST changes, use
  [code-first-architecture](../code-first-architecture/SKILL.md).
- Boundary callbacks declare `BoundaryContext<Input>`. Step helpers have one
  destructured object parameter and a `"use step"` directive. Workflow, scope,
  step, and parameter metadata use JSDoc `@displayname`, with optional
  `@description` and `@icon`. Keep examples parseable and honest about their IO.
- A boundary is a retry unit, not an external transaction. Returned transitions
  persist continuation; ordinary step helpers are not independent checkpoints.
  Treat JSON boundaries and stable side-effect identity as runtime contracts.
- Temporary means session-owned, with optional expiry. Preserve the lifetime,
  host placement, archive cancellation, and independent attention rules in
  [ADR 0139](../../../docs/decisions/0139-session-reminder-lifetime-and-attention.md).

## Keep guidance discoverable

The strings are assembled in [seeds.ts](../../../packages/core/src/seeds.ts).
`writing-workflows`, `durable-workflows`, and `batch-workflows` are project seeds;
`workflow-lifecycle` and `session-workflows` are host-tier skills, available to
existing projects without overwriting customized files. Project skills shadow
user and host skills of the same name. Preserve host injection and that precedence.

Keep one maintained explanation per concern and route by skill name when a host
reader cannot load repository paths. Host skill discovery reads `SKILL.md` by
name; do not move essential recipes to an unserved reference file. Seed support
files can use relative links when those files are actually shipped.

A framework contract change needs updates to its skill, examples, affected
sibling guidance, and ADR status/index when an older decision is superseded.
Do not copy runtime API catalogs or the same lifecycle manual into every skill.
Do not replace project customization merely to refresh shipped defaults.

## Verify behavior

Run the repository's required checks. For authoring changes, parse and typecheck
the actual examples against the public API and host trigger declarations. Execute
meaningful branches: a rejected/timed-out approval must not call its child; a
quiet monitor must not deliver; a reminder must request attention without a model
turn; paged sources must replay and terminate correctly.

Check source isolation, selected exports, skill discovery across host/project
surfaces, and retained provenance when those contracts change. Wording substring
tests do not prove usable guidance. Validate frontmatter and local links, and
exercise applicable retry, restart, stop, and remote queued-delivery paths.
