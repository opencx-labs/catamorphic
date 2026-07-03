# 0010 — Per-project agent skills live in the project repo (`.agents/skills/`)

- **Status**: accepted
- **Date**: 2026-07-02

## Context

Catamorphic users need to teach the coding agent project-specific knowledge
(conventions, domain vocabulary, recipes). That knowledge needs a single
source of truth, multi-tenant scoping (per project), versioning, and it must
be visible to the agent where it works — inside the dev sandbox. Options
considered: a dedicated skills table in Postgres, a separate Artifacts
namespace keyed by project, or files inside the project repository itself.

## Decision

Per-project skills are **plain files in the project repo** under
`.agents/skills/<name>/SKILL.md`, following the
[Agent Skills](https://agentskills.io) layout (YAML frontmatter with `name` +
`description`, markdown body, optional support files next to it).

Because the project repo's origin *is* the code-storage backend (Cloudflare
Artifacts on the CF stack, ADR 0004), this gives us everything for free:

- **Single source of truth + multi-tenancy**: skills live with the project,
  in the same Artifacts repo, scoped per tenant/project by construction.
- **Versioning & review**: skills flow through the same draft → deploy → git
  history as workflow code; agents can even edit their own skills.
- **Sandbox access**: the dev sandbox clones the project from Artifacts, so
  skills are on disk at `<project>/.agents/skills/` where Flue's workspace
  discovery picks them up natively — no extra distribution channel.

Supporting changes:

- `@catamorphic/git`'s file walker allowlists the `.agents/` dot-directory so
  skills are committed, uploaded, listed, and synced like normal files.
- `SkillsService` (`core.skills`) lists a project's skills by parsing SKILL.md
  frontmatter; exposed at `GET /projects/:id/skills`. Writing skills is just
  writing files through the existing file APIs.
- Every new project — template-based or blank — is seeded with
  `.agents/skills/writing-workflows/SKILL.md` (`SEED_SKILLS` in core) so its
  agent knows the workflow conventions from the first session.

Host-application-level skills (not project-specific) are **not** stored in
catamorphic at all — hosts pass them to their agent directly (e.g.
`FlueCodingAgent`'s `skills` option).

## Consequences

- No new storage system, tables, or sync jobs; one fewer thing to scope per
  tenant.
- Skills count as project files: they appear in file listings and diffs (the
  UI may later choose to group or de-emphasize them).
- A skill is only as fresh as the sandbox checkout — the dev sandbox refresh
  path (upload/clone on session start) is what propagates skill edits.
