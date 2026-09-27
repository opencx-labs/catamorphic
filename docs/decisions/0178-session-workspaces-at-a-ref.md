# 0178: Session workspaces at a ref of the project's remote

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0044, 0100, 0173, 0175

## Context

Reviewing a change means working in the project as of that change. A chat's
workspace could only start from the project's own published tree, so an
automation could not give an agent "this pull request's head", and nothing
recorded which commit a review looked at. Sandboxes hold no Git credential, so
they cannot fetch the ref themselves, and large repositories make a fresh
clone per chat expensive.

## Decision

**A session's workspace has a base: a ref of the project's linked remote.**
`create` and `deliver` (workflow host operations, the project MCP, REST)
accept `workspace: { ref, update? }`, where `ref` is a branch, tag, commit,
or full ref such as `refs/pull/42/head`. The chat records its base as
`workspace: { ref, commit }` in its snapshot, so a review cites exactly what
it reviewed.

**The control plane fetches; sandboxes are seeded.** The host keeps one bare
mirror per project (`StorageBackend.mirrorPath`), fetches the ref into it
with the credential of the session's Git-capable binding (ADR 0175) or,
failing that, the code host's (`RemoteSyncService.origin`, the one lookup of
origin credentials), and pins the commit per session. For sandbox agents the
commit is published as the session's `sessions/<id>` branch, so idle release
and rehydration (0173) keep it, and the sandbox is seeded from the session's
copy as one uploaded shallow pack: the checkout stands on the base commit with
real history back to it and the session's saved work uncommitted on top.
Work's checkpoint commits never reach anything the agent pushes. Native
agents (the desktop) get a managed worktree created at the commit. A chat at
a ref always works in its own copy, never a member's dev copy, and does not
sync the project store (it holds the remote's tree, not the project's).

**Later deliveries move the base.** A delivery naming a ref the open chat is
not on fetches it at once and applies the move before the chat's next turn:
`rebase` (default) replays the chat's work since the old base onto the new
one, `reset` discards it. A conflicting rebase is undone and reported to the
agent instead of failing the delivery. The agent is told the old and new
heads and which files changed between them.

**Sandbox sync compares trees.** The per-turn copy of sandbox changes now
diffs a snapshot of the working tree against `refs/work/synced` in a private
index, so commits and branches the agent makes with live Git are copied like
any edit and never hidden from checkpoints.

Considered: cloning the ref inside the sandbox through the gateway (puts the
whole transfer on every chat and needs a Git binding even to read);
blobless partial mirrors (session copies need complete objects to checkpoint,
so this is deferred until copies can borrow the mirror's objects).

## Consequences

A pull request automation delivers to `pr-<n>` with
`workspace: { ref: "refs/pull/<n>/head" }` and each push moves the same chat.
Projects without a linked remote cannot start at a ref. Mirrors grow with
every fetched ref and are pruned only by deleting the project; pins are
dropped when a chat closes. A project chat started by a project automation
still uses only the enablement's consented connections (0173), so it seeds
from the code host's credentials unless the chat's Environment binding is
available to it.
