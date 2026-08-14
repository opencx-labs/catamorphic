# 0049 — Doctrine is the embedder's

- **Status:** Accepted (the `projectTemplates` hook and template
  composition are superseded by 0051 — templates are removed)
- **Date:** 2026-08-14
- **Builds on:** 0010 (skills in the project repo), 0043 (general-purpose
  projects), 0048 (app feel is the embedder's)

## Context

0048 made the app kit's *pixels* host-owned; the framework's *words*
were still ours everywhere. The seeded `building-apps` skill interleaved
framework contracts (bundle shape, the typed app contract, storage
semantics) with design doctrine (the `@catamorphic/app/ui` inventory,
layout/motion rules) — an embedder with its own design system could not
replace one without losing the other. Project templates baked `SEED_SKILLS`
into their file maps at module load, so no host-supplied seed set could
reach a template-created project. And every coding-agent session opened
with our hardcoded workflow-authoring standing prompt.

The dividing line: **mechanics** are framework contracts that hold in any
host; **doctrine** is what work should look like in *this* host — exactly
the knowledge ADR 0010 said hosts own at the application level.

## Decision

**The framework ships mechanism plus good defaults; every doctrine default
resolves through host config; the desktop consumes the same hooks as any
embedder (passing nothing, taking the defaults).**

### Mechanics/doctrine split in the seeds

`building-apps` (mechanics): workspace shape, the IIFE bundle contract and
required vite `define`, `#root` mount, the typed app contract/client and
generated app-api types, build/verify flow, preventDefault-on-submit (the
CSP finding), storage semantics and quota, sandbox/CSP constraints, "you
build and preview; a human publishes". It ends by pointing at the design
skill **by role, not name**: "consult the designing-apps skill for this
workspace's UI standards, when present".

`designing-apps` (doctrine, the replaceable default): the
`@catamorphic/app/ui` inventory and usage, host-token styling rules, the
three-data-states pattern, layout/motion doctrine, do-nots.

### Three hooks on `CatamorphicCoreConfig` (mirrored by `createCatamorphic`)

```ts
projectSeeds?: (defaults: Record<string, string>) => Record<string, string>;
projectTemplates?: (defaults: ProjectTemplate[]) => ProjectTemplate[];
standingAgentPrompt?: string | false; // undefined = default, false = none
```

Each receives the framework defaults (a copy) and returns the host-final
set; replacing or removing entries is legitimate. Resolution happens
**once**, in the core's constructor; `ProjectsService`,
`AgentSessionsService`, and the fastify `/templates` route all consume the
resolved values. `workspaceFiles` / `appScaffold` are exported so embedder
templates build on the canonical scaffold.

### Composition rule

Templates no longer spread `SEED_SKILLS` at module scope. Creates compose:
blank → the resolved seeds; template → `{...seeds, ...template.files}`,
the template winning path collisions. Every template — framework or
embedder — therefore picks up the host's seed set.

### Restore-path semantics

The per-turn batch/durable skill restore reads from the **resolved** seed
map. A skill path absent from it makes the restore a no-op: an embedder
that removed our workflow skills never has them resurrect. The ADR 0043
workspace gate (`workflows/package.json` exists) stands in front of it.

## Consequences

- An embedder swaps `designing-apps` for its own doctrine skill without
  forfeiting the mechanics; the alien-embedder integration test creates
  blank and template projects and asserts the on-disk seed set is exactly
  the host's.
- The desktop passes none of the hooks and is behaviorally unchanged —
  the proof the defaults are real defaults.
- `buildAgentSystemPrompt` stays API-compatible; the standing prompt is
  now an argument with the workflow primer as its default.
- Doctrine text lives in host config, not forks of the framework.
