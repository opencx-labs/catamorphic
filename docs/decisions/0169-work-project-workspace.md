# 0169: The project workspace is `.work/`

- **Status:** Accepted
- **Date:** 2026-09-26
- **Supersedes:** the `.catamorphic/` path in 0142; "project `.catamorphic/` paths" as a framework contract in 0146
- **Refines:** 0142, 0146

## Context

A company that opens its main repository as a Work project sees everything
Work adds in its tree, its history, and its code host. ADR 0142 already keeps
all of it under one folder, but that folder, the Git refs Work keeps, the
branches it creates, and the author of its commits carried the framework's
name, not the product's. People reviewing a pull request that touches
`.catamorphic/roles/admin.json`, or a branch called `catamorphic/…`, should
not have to know what Catamorphic is.

## Decision

Everything that lands in a user's repository or on their code host is named
for the product:

- The contained project workspace is `.work/` (ADR 0142's model, unchanged:
  created only when a capability needs it, scoped `.work/.gitignore`,
  app data under `.work/app-data/`).
- Published tracking refs are `refs/work/published/<branch>`.
- Branches Work creates start with `work/` (session worktrees, review
  checkouts, pull request branches, rescue branches, artifact refs).
- Checkpoint commits are authored by "Work Agent".
- Local app data reaches executions at `WORK_APP_DATA_DIR` (mounted at
  `/work-app-data` in sandboxes).

These names are defined once in `@catamorphic/workflow/project-layout`;
code derives paths from it, and a repository check keeps the old names from
returning. Package scopes (`@catamorphic/*`), library interfaces, host
storage (`~/.catamorphic/dev`), and internal identifiers stay framework
names, as ADR 0146 decided for everything a user's repository never sees.

Pasted attachments are chat material, not project content, and never land
in the working tree.

No migration: existing alpha projects move their folder by hand
(`git mv .catamorphic .work`) or are re-seeded.

## Consequences

A repository's history shows `.work/` and `work/` branches only. Hosts that
embed Catamorphic inherit the product layout; making it host-configurable is
now a one-module change if an embedder ever needs it.
