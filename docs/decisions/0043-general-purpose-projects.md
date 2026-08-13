# 0043 — Projects are general-purpose; the workflow workspace is scaffolded on demand

- **Status:** Accepted
- **Date:** 2026-08-13
- **Revises:** 0032 (the workspace layout stands, but its *presence* becomes optional)

## Context

Catamorphic Desktop is a place to do work in general. A project is a folder
that can hold documents, notes, data, plans, code, automations, and apps —
in any mix. Most of the machinery already agrees: imported repositories are
adopted as-is ("existing files are never overwritten"), and a project with
no workflows simply lists none.

Blank projects disagreed. Creating one eagerly scaffolded the full bun
workspace — root `package.json`, `contracts/`, `workflows/` — so a project
meant to hold meeting notes looked like a TypeScript codebase from its
first second. Worse, that eager scaffold in `@catamorphic/git`'s
`ProjectManager` was a *second, drifted copy* of the workspace layout: the
template scaffold in core (`workspaceFiles`) seeds the `check` script and
the `@catamorphic/parser` devDependency; the blank-project copy never did.

There was also no place for project-scoped Catamorphic metadata. Config
that belongs to the project (not to a profile, not to the app) had nowhere
to live, and a folder carried no marker that it *is* a Catamorphic project.

## Decision

**A blank project is a git repository, a manifest, and the seed skills —
nothing visible.**

```
.catamorphic/project.json     # { "name": "<project name>" }
.agents/skills/…              # seed skills (hidden, reference-only)
```

`.catamorphic/` is the project-owned metadata directory, following the
`.obsidian`/`.vscode` convention: hidden directories hold tool metadata;
the user's visible tree holds only their work. (The sandbox already stages
desktop config mirrors under `.catamorphic/desktop/`, so the name has
precedent.) The manifest starts minimal — `{ "name" }` — and is the future
home for project-scoped config (storage backends, roles). The file walker
allowlists `.catamorphic/` alongside `.agents/` so it commits and syncs
like a normal file.

Manifest writes by origin:

- **Blank create**: manifest written, workspace not scaffolded.
- **Import existing folder**: manifest written (never overwriting one that
  exists); contents adopted as-is, unchanged from before.
- **Clone from a remote** (GitHub import): nothing written — imported
  history stays pristine. The manifest appears only when project-scoped
  config is first needed.

**The workspace is scaffolded on demand, from one canonical source.** The
0032 layout (`contracts` / `workflows` / `apps/*`) is unchanged — but it
appears the first time someone adds an automation or app, not at project
birth. The canonical scaffold lives once, in core's `templates.ts`
(`workspaceFiles` + the seeded check script); `ProjectManager`'s duplicate
blank-project scaffold is deleted. The scaffold reaches projects two ways:

1. **Templates** include it in their file maps, as before.
2. **Agents** install it via the seeded `catamorphic-projects` skill: the
   SKILL.md explains the general project model and carries the scaffold
   files as skill support files (generated from the same `workspaceFiles`
   constants, so they cannot drift), which the agent copies into place
   when the user first asks for an automation or app.

**Workflow skills stop resurrecting in projects that have no workflows.**
The per-turn restore of `batch-workflows` / `durable-workflows` SKILL.md
is gated on `workflows/package.json` existing. Seeding all workflow
reference skills at creation stays — they are hidden, consulted only when
workflow work happens, and mean the agent knows the conventions from its
first session — but a project that never grows a workspace never has them
forced back after deletion.

## Consequences

- A docs-only or imported project shows exactly the user's files. Nothing
  in the visible tree claims the project is about code.
- The blank-project scaffold can no longer drift from the template
  scaffold; there is one workspace definition.
- Agents must scaffold before the first workflow. The `catamorphic-projects`
  skill makes that a copy step, not a from-memory reconstruction.
- `bun run check` exists only once the workspace does — consistent with it
  having nothing to check before then.
- Machinery must tolerate an absent workspace. Imported plain repositories
  already exercised this path; blank projects now do too.
