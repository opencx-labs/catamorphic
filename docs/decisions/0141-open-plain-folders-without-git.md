# 0141: Open plain folders without initializing Git

- **Status:** Accepted
- **Date:** 2026-09-17
- **Refines:** 0043, 0104

## Context

Opening an existing project should make its files available to the desktop and
agent. Git history is useful for recording and publishing work, but it is not a
prerequisite for reading or editing a folder. Import must not scaffold a project,
copy its history into internal storage, or require a Git initialization prompt.

## Decision

Register existing folders in place through the same host-owned local path
mapping used for Git checkouts. Discover repository roots, linked worktrees,
remotes, and canonical aliases when Git exists. A plain folder remains plain;
invalid repositories and bare repositories are rejected rather than repaired.

The local repository adapter reads and edits working files without Git and uses
native Git as soon as the folder has a repository. Its first explicit commit can
initialize Git. Import and ordinary agent turns never initialize, commit, seed,
or upload an attached folder. File discovery respects ignore rules and excludes
nested repositories and local-only personal files.

Keep ADR 0104's publication model: no duplicate local origin and no history
traversal during import. Explicit publication retains a committed snapshot in
the checkout's existing object database. Local owner reads use working files;
scoped readers and published executions use published versions. Shared server
storage continues to use the host's injected backend.

## Consequences

GitHub clones, existing Git checkouts, repositories without remotes, and plain
folders all open into the same project experience. Git-dependent actions still
require an explicit recorded version. Existing imported folders retain manual
commit behavior, including after Git is initialized outside Catamorphic.
