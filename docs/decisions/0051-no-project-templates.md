# 0051 — No project templates: agents build from skills

- **Status:** Accepted
- **Date:** 2026-08-14
- **Builds on:** 0043 (general-purpose projects), 0049 (doctrine is the
  embedder's). Supersedes the template parts of 0049 (the
  `projectTemplates` hook) and of 0043 (templates as a workspace
  installer).

## Context

Project templates predate capable coding agents: a fixed catalog of
starter file maps (`TEMPLATES`), a `/templates` route, a picker in the
desktop create dialog, and a `projectTemplates` embedder hook. In
practice a template is a snapshot of what an agent would write anyway —
except it goes stale, it front-loads a choice the user shouldn't have to
make at create time ("which starter matches what I'll eventually
want?"), and it competes with the real mechanism: the seed skills, which
teach agents how to build *anything* in this workspace, on demand.

The catalog was also dead weight for embedders. ADR 0049 already made
the seeds the host's; a parallel template catalog meant two ways to
shape a new project, one of which bypassed the "workspace on demand"
model of ADR 0043.

## Decision

**Remove the template concept everywhere. A project is always created
blank (seed skills only); agents build everything else, guided by the
seed skills and their copyable support files.**

- `ProjectTemplate`, `TEMPLATES`, `findTemplate`, the `projectTemplates`
  hook, the `/templates` route, `useTemplates`, `templateId` on every
  create surface, and the desktop template picker are all deleted.
  `packages/core/src/templates.ts` becomes `seeds.ts` — the seed skills
  and canonical scaffold constants are what remain.
- The investment moves into the skills. What templates used to
  hand-deliver, skills now teach *and ship as copyable files*:
  - `catamorphic-projects` carries the workspace scaffold as support
    files (unchanged from ADR 0043).
  - `building-apps` now carries the per-app scaffold
    (`package.json`, `tsconfig.json`, `vite.config.ts`, `main.tsx`) as
    support files, generated from the same constants as `appScaffold` so
    they cannot drift. An agent creating `apps/<name>/` copies, renames,
    and writes only `src/app.tsx`.
- `workspaceFiles` / `appScaffold` stay exported: they are the canonical
  scaffold (one source of truth for the skills' support files), not
  templates.
- Embedders shape new projects exclusively through `projectSeeds` (and
  `standingAgentPrompt`): a host that wants domain scaffolding writes a
  skill that teaches it, not a frozen file map.

## Consequences

- Create flows have exactly one shape: name (+ location on desktop). No
  picker, no `templateId` validation path, no stale catalog to maintain.
- Example/starter code no longer ships inside the framework; the parser
  keeps its own fixture-based coverage, and `seeds.test.ts` pins the new
  guarantee — every file a seed skill tells the agent to copy actually
  ships, and the copyable scaffolds match the canonical constants.
- The quality bar moves to prompts and skills: if agents scaffold poorly,
  the fix is a better skill, never a new template.
