# 0215 — A chat's own worktree: chosen by the person, set up, put away, brought back

- **Status:** Accepted
- **Date:** 2026-10-09
- **Refines:** [0063](0063-agent-checkout-coordination.md), [0045](0045-desktop-as-dev-shell.md), [0208](0208-workspaces-keep-what-members-build.md)

## Context

ADR 0063 left worktrees to agents: a chat starts in the project folder and
only an agent's `create_worktree`, or an `isolation-required` agent meeting
another chat in its folder, gives it one. People had no way to ask for one,
a new worktree had none of the project's ignored files or installed
dependencies, nothing ever removed one, and its changes came back only
through a pull request. The Codex app and Claude Code both let the person
choose per chat, copy listed ignored files (`.worktreeinclude`), and remove
worktrees when chats are archived; their users' main complaints are worktrees
they cannot opt out of and worktrees that pile up.

## Decision

**The project folder stays the default; the person can choose a worktree.**
"New chat in a worktree" in the palette, or "Use own worktree" in a chat's
status popup between turns, gives the chat its own worktree. Agents keep
their tools and coordination strategies (0063). A chat that adopts another
chat's own worktree only uses it: it is that chat's assigned worktree, and
nothing below removes a worktree another chat is bound to.

**A chat's own worktree exists only while the chat needs it.** Choosing one
records it before the chat's first message is sent; the next turn creates
it, at the project folder's current commit, on branch `work/<session>`, in
host storage under a folder named after the project. Uncommitted changes in
the project folder stay there. Each turn checkpoints the worktree to the
branch it is on (0104). Archiving or closing the chat records anything left
and removes the folder, keeping the branch; the next turn checks it out
again, and turns wait for a removal under way. The folder stays when
removing it could lose work: a turn runs in the chat, it holds personal
files (`.work/personal/`, which Git cannot record), or Git is mid-merge,
mid-rebase or off a branch there. When the desktop starts it puts away what
a chat archived mid-turn, or an agent that returned to the project folder,
left behind.

**A new checkout is set up before the turn.** Ignored files that match the
project's `.worktreeinclude` (gitignore syntax, the file Codex and Claude
Code read) are copied from the project folder, never overwriting and never
following symlinks. Then the chat's Environment `setup`, and the person's
own (0208), run in the worktree with bash and the person's login PATH, as
in a new sandbox workspace: the chat shows "Setting up the workspace", a
failure is told to the agent with the end of the log, and the turn goes on.
This applies to every worktree a chat owns, including those agents create.
Unlike a sandbox, the commands run with the person's own environment, not
the Environment's secrets or gateway variables. What last succeeded is
recorded in the worktree's own Git directory, so a recreated worktree sets
up again. The project folder never runs setup.

**The popup brings the work back.** Between turns, the chat's status popup
shows where it works and offers:

- *Bring to project folder*: the chat's changes since its branch left the
  project folder's history are merged three ways with the folder's current
  commit and written there as uncommitted changes, byte for byte through Git
  plumbing whatever the person's diff settings. It is refused, changing
  nothing, when the merge conflicts, the folder's own uncommitted changes
  touch the same files, a submodule moved, or the worktree holds personal
  files or is mid-operation. Then the chat continues in the project folder,
  and its worktree and branch are removed.
- *Discard worktree*: after a confirmation, the worktree and the chat's
  branch are removed and the chat continues in the project folder.

The agent is told, every turn, which folder it works in and how its changes
reach the project folder, and once when the person moved it. Work's own
checkpoint commits skip the project's commit hooks and signing.

Considered: starting from a fresh `origin/<default>` like Claude Code
(bringing changes back into the folder works best from the folder's own
commit; a remote ref is still available through 0178); Codex's handoff that
checks the chat's branch out in the person's folder (it moves the person
off their branch); a worktree for every chat (non-code projects expect one
visible folder, and it is the main complaint about Claude Code); a separate
setup file for worktrees (the Environment already says how a new workspace
is set up).

## Consequences

Parallel engineering chats start from the palette and need no Git from the
person. Worktrees no longer accumulate: archived chats hold only a branch.
Ignored files other than `.worktreeinclude` matches and setup output do not
survive putting a worktree away. Choosing a worktree runs the project's
committed `setup` on the person's machine without asking, as an agent
installing dependencies would; a `setup` written for a Linux sandbox now
also runs there. A fork of a chat in a worktree still starts in the project
folder.
