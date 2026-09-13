# 0136: Local work and project proposals

- **Status:** Accepted
- **Date:** 2026-09-12
- **Refines:** 0063, 0068, 0104, 0132

## Context

A company brain contains shared source and personal work. Creating a document
must not silently publish it. Members without repository credentials must be
able to suggest changes, and builders must review those changes in the app.
Worktrees must not turn ordinary document work into copies in unexpected folders.

## Decision

New personal files default to the existing profile-local personal namespace.
The desktop discovers its own profile's files locally. Shared APIs, Git
checkpoints, remote sync, and proposals continue to exclude that namespace.
Explicit user folder choices remain authoritative. Editing an existing file
changes its local copy; saving, proposing, and publishing are separate actions.

File status, the actual location, Save, Publish, and Propose live in the file's
top controls, using the same resource inspector as chat. Sharing a personal
file is an ordinary agent-assisted project change under ADR 0068, not a second
artifact or promotion model. Proposals submit explicitly selected files.

The host's existing CodeHost connection opens PRs on behalf of members.
Members read only proposals whose files their document scope permits; builders
review using their own repository identity. The existing PR sidebar and review
surface present proposals. Review and apply actions target the reviewed commit;
repository protections remain authoritative. Stock-server setup may import a
GitHub repository through the existing GithubService. Applied proposals remain
readable through the same scoped review API. The open sidebar remains an inbox.
The stock host exposes the existing proposal capability to its agents.
Published-repository synchronization fetches accepted changes only; it must not
push a working copy or merge unreviewed changes into the published branch.

Ordinary document edits stay in the current folder. Worktrees serve independent
repository state, explicit isolation, or configured coordination policy. A new
chat, private file, or proposal alone does not require a worktree. Returning to
the primary folder preserves the reusable managed worktree. An unavailable
assigned worktree stops the operation until an explicit recovery choice.
Chat status exposes the actual assigned folder and Use project folder for
recovery without a running agent. Both UI and agent actions use the same
assignment lock and isolation policy; an active turn cannot be redirected by
the UI. Native harnesses apply the live assignment to each resumed turn.

## Consequences

Members need no GitHub credentials to propose changes. Reviewable changes and
local work share one file model without making Git state a privacy boundary.
Remote execution cannot promise a device-local file; the desktop must use local
execution or explain that limitation. Accepted proposals still need ordinary
remote synchronization before members see the new shared version.
