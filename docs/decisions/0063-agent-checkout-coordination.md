# 0063 - Agent coordination and optional worktree isolation

- **Status:** Accepted
- **Date:** 2026-08-23
- **Builds on:** 0044 (whole-checkout checkpoints), 0045 (desktop worktrees), 0050/0056 (agent definitions and configuration)
- **Refines:** 0044's shared-folder stance and 0045's deliberate-worktree stance

## Context

Catamorphic projects hold code, presentations, documents, data, and other
work. Automatically assigning every chat a worktree would protect coding
agents but hide ordinary work from users who expect every result in one
visible folder. Always sharing the folder is equally wrong when concurrent
engineering agents run branch-wide commands or modify overlapping code.

Agents already have the semantic context needed to judge whether work can
safely share a checkout. What they lack is visibility into peer sessions and
a harness-neutral way to choose isolation.

## Decision

Sessions start in the primary project checkout. Creating a session never
creates a worktree. Before each turn, agents receive project-scoped summaries
of other active sessions and may read their bounded transcripts. They choose
to share the checkout, wait, or create/adopt a worktree.

Sharing is deliberately simple. Sessions in one checkout share files, Git
state, whole-tree checkpoint commits, and rollback. Catamorphic does not add
file claims, per-agent staging, change attribution, or conflict resolution.
Checkpoint Git operations serialize, but a checkpoint remains the checkout
state at turn completion rather than an authorship claim, as established by
0044.

The desktop owns top-level checkout selection and passes the resolved path to
every harness. Claude Code's top-level worktree-switching tools stay disabled;
Codex receives the same neutral operations through a session-scoped loopback
MCP server. Harness-internal isolated subagents remain valid.

Coordination doctrine is configurable per agent definition:
`shared-first`, `isolate-on-contention`, or `isolation-required`. The default
is `shared-first`. Worktree bindings and filesystem paths are desktop-local
host state, not shared Catamorphic schema. External worktrees may be adopted
but are never automatically removed.

Peer discovery is project-scoped by default. Cross-project discovery requires
an explicit host capability, and the desktop excludes incognito sessions.

## Consequences

- CSM, operations, and content agents can work concurrently in the visible
  project folder without learning Git worktrees.
- Engineering agents can isolate only when contention warrants it, with the
  same tools across Claude Code, Codex, and future harnesses.
- Users must understand that rollback in a shared checkout affects every
  session using it; the product must never imply per-agent ownership there.
- Host-execution path resolution and checkpoints become session-aware.
- Worktree turns do not automatically sync the primary branch. Sharing from a
  worktree is explicit through integration or pull-request flows.
- Incorrect agent judgment can still produce ordinary last-write-wins file
  collisions. That is an accepted cost of the intentionally lightweight
  shared mode.
