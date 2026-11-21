# 0342 — Every server chat stands on a branch

- **Status:** Accepted (amends [0173](0173-keyed-chat-lifecycle-and-chat-placement.md), [0178](0178-session-workspaces-at-a-ref.md), [0191](0191-member-drafts-are-refs-in-the-project-origin.md), [0257](0257-setup-has-its-own-network.md) and [0341](0341-a-workspace-is-saved-as-a-git-pack.md))
- **Date:** 2026-11-20

## Context

Sandbox chats had two workspaces. One started with `workspace: { ref }`
stood on a commit of the project's repository. Every other chat, which is
every interactive one, got a "local baseline": the project's files uploaded
as text and committed as one commit with no history and no remote. A save
carried trees only, so after an idle release the agent's branch and commits
were gone, its work folded into a new baseline. The unit of change people
care about is the pull request an agent opens, and neither workspace kept
what one is made of.

## Decision

**One workspace: every sandbox chat stands on a real commit, on a branch
of its own, saved and restored as Git.** `agent_sessions.workspace` is
never null for one. With no ref asked, the base is the default branch of
the linked repository (`default_branch`, else `remote_branch`, else
`main`), fetched into the host's mirror; with no repository, or one that
cannot be reached (the agent is told once), it is the project's own `main`.
The branch is `work/<first 8 hex of the session id>`, as on the desktop;
the agent may rename it or switch.

**Work's checkpoint is a separate ref, never the agent's branch.**
`sessions/<id>` gains one commit per save: its tree is the working tree as
snapshotted, its parents the checkpoint before it and then the agent's
HEAD, its trailers `Work-Branch`, `Work-Head` and (ADR 0343)
`Work-Pushed`. One ref and one compare-and-swap keep a rollback, the
agent's commits and its branch name together; the database holds nothing
new. A checkpoint is written when HEAD or the branch moved, not only when
files changed.

**Save** extends ADR 0341's pack with what HEAD reaches beyond the commits
the control plane names (the base and the last saved HEAD), and reports
HEAD and the branch. The sandbox is untrusted: the pack is indexed in the
throwaway repository with Git's object checks, beside the session copy's
objects; every new tree entry must be one name a checkout may hold, with a
mode of a folder, file, link or nested repository; commits and bytes are
bounded; history must arrive whole and end at what the copy holds (a
commit with no parent is refused); the branch name must be a valid ref
name. What passes is unpacked loose into the copy with
`unpack-objects --strict`, so no pack stays behind. **Restore** installs
one shallow pack (HEAD back to the base, plus the checkpoint's tree),
checks out the branch at HEAD and puts the saved tree in the working tree
alone. **Base moves** rebuild the agent's checkout in the copy (HEAD, its
uncommitted tree as one more commit) and reuse `moveCheckoutBase`.

Deleted: the baseline, the text upload and origin clone for chats, the
draft branch of the chat's save and checkpoint, the no-base setup refusal,
and store sync around turns (`storeSyncAroundTurns`), which only ever ran
for baseline chats. Considered and rejected: keeping checkpoints on the
agent's branch (they would reach its pull request), a branch table in the
database (a second thing to keep in step with the ref), and a
`refs/work/saved-head` in the sandbox (the control plane naming what it
holds heals a checkpoint that failed after a save).

## Consequences

- The branch, its commits and the uncommitted diff (bytes, modes, links)
  come back. Staged changes come back unstaged. Other local branches,
  ignored files, `$HOME` and a rebase in progress do not.
- History is shallow at the base; `git fetch --deepen` brings more where
  the Environment binds Git.
- Every chat qualifies for a setup on its own network (0257), forks too.
- Open chats without a base get one before their next turn, their saved
  files uncommitted on it. A chat that saved into a member's draft starts
  from the base alone; the draft keeps what it held.
- A typed result's `commit` (ADR 0323) is the agent's HEAD when its turn
  began, as its checkpoint records it, not the checkpoint.
- A sandbox whose checkout lost its repository is never seeded over: its
  saves fail with the reason until the repository is back.
- ADR 0191's rule stands: `sessions/<id>` is never returned by an API; work
  leaves only as a pushed `work/` branch (ADR 0343).
- Agents reach `store/` through the documents surface, not their checkout.
