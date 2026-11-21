# 0343 — One pull request tool

- **Status:** Accepted (amends [0170](0170-attached-repositories-receive-pull-requests.md), [0177](0177-github-is-a-connection.md) and [0322](0322-server-agents-start-subagents-in-their-workspace.md); narrows proposals, ADR 0055)
- **Date:** 2026-11-20

## Context

Agents had two ways to ask for review and neither was their work. The
desktop's `create_pull_request` pushed a fresh `work/<title>-<stamp>`
branch on every call, needed `program:write`, and left recording the pull
request to the agent. Server agents had only `propose_change`, which
commits files the agent hands over on a new branch from `main`, never the
commits in its sandbox. With every server chat on a branch
([0342](0342-every-server-chat-stands-on-a-branch.md)), both can be one.

## Decision

**One `create_pull_request({ title, body? })`, defined once in core**
(`pullRequestTool`, as `subsessionTools` is, ADR 0322). The desktop builds
it over its checkouts; a server serves it through capability discovery as
`project.create_pull_request`. Both run one core function,
`PullRequestsService.openForChat`:

1. The host finds the chat's checkout: a server saves the sandbox now and
   takes the agent's HEAD in the session's copy; the desktop takes the
   chat's worktree (checkpointed) or the project folder.
2. The control plane pushes that commit, so an Environment needs no Git
   binding: with the caller's connection or the organization's, as the
   chat's own branch (its local name when under `work/`, else
   `work/<name>-<short id>`), audited as a gateway push is.
3. It opens the pull request through `CodeHost.createPullRequest`, or
   returns the one already open for that branch. The base is the ref the
   chat started from when the repository has it as a branch, else the
   default branch.
4. It records the pull request in the chat's `pull_requests` metadata.

Uncommitted files are named in the result and not pushed. It needs what
proposing needs (using the project), not `program:write`: the connection
decides what reaches the repository.

**A chat may replace its own branch, and only it.** This amends ADR 0170's
"never rewrite history" for one case: after a rebase the push is forced
with a lease on the commit this chat last pushed there
(`--force-with-lease=<ref>:<commit>`), so anything a person or another
chat pushed since refuses it with a reason instead of being overwritten.
Creating uses a lease on absence; moving forward needs no force. The last
push is kept where the agent cannot write it: a server chat's checkpoint
trailer (`Work-Pushed`), a desktop chat's `refs/work/pushed/<branch>`.
Never a branch outside `work/`, never a deletion.

With no repository it refuses: "This project is not connected to a
repository, so there is nowhere to open a pull request. The branch is
saved with this chat."

`propose_change` leaves agents that have a workspace. `ProposalsService`
stays for callers without a checkout (the member tools, the HTTP surface)
and opens its pull request through the same service from its ephemeral
checkout. `sync_project` stays the desktop's. Considered and rejected:
pushing from the sandbox through the gateway (every Environment would need
a Git binding, and the record of what was pushed would live where the
agent writes), and a blind force on `work/` branches (it would overwrite a
reviewer's commit).

## Consequences

- A second call updates the same pull request; agents no longer record it.
- A pull request holds the agent's own commits and authorship, as a
  gateway push does.
- A rollback to an earlier checkpoint forgets a later push; the next call
  then moves the branch forward or refuses, never overwrites.
- The MCP surface's own redesign consumes `pullRequestTool`.
