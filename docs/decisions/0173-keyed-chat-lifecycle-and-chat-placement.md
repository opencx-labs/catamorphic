# 0173 — Keyed chats: project keys, close, idle release, and their own placement

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0100, 0156, 0167

## Context

Automations keep one chat per external thing (a pull request, an incident) by
delivering with a key (0156). The key was scoped to the delivering workflow, so
"review on open" and "clean up on merge" could not reach the same chat. Nothing
could find or close a chat by key; archive kept the key, and deliveries to an
archived chat queued turns the drainer silently skipped. An idle chat held its
workspace slot and reservation forever (0100). A delivered chat also inherited
the automation's Environment, so a reviewing agent could only run in a `review`
pool if control-plane machines carried that label too.

## Decision

**Keys belong to the project.** A key is the project's name for one open chat
(1 to 200 characters, no control characters); any automation in the project
reaches it. One open chat per project owner and key; the chat records the
workflows that delivered to it (`keyWorkflows`) and exposes `key`.

**Every session operation names its chat by `{ sessionId }` or `{ key }`**
(with `audience` as in `deliver`): inspect, history, archive, unarchive, close,
interrupt, complete, reopen, stopWatcher, fork, spawn. `find({ key })` returns
the open chat or null and never creates one. The same shapes serve workflows,
the project MCP (`session_*`), and REST (`GET`/`DELETE
/projects/:id/agent/chats/:key`). A key lookup grants nothing; the usual
session access check decides, and a chat the caller may not see answers
exactly like no open chat.

**`close` ends a chat's life.** For the chat and its subsessions it cancels
queued work, interrupts running work, stops watchers, releases the workspace
Allocation (the node destroys the sandbox), revokes connection grants, deletes
the `sessions/<id>` branch and the `session-<id>` copy, and frees the key. The
transcript stays readable. A later delivery for the key starts a new chat.
Work delivered while running turns stop is cancelled with the closing.
Closing a key with no open chat, or a chat already closed, is a no-op
(`{ closed: false }`); retrying a close that stopped partway finishes it.

**Archive is only visibility.** Delivering work to an archived chat restores it
for everyone who archived it and runs; the drainer never skips a queued turn
because of archive. A released workspace is admitted again when the turn is
claimed.

**Idle release.** A chat on a worker that has had no turn for its
Environment's `idleReleaseMinutes` (default 30, `0` disables) gives back its
workspace: the sandbox is synced and checkpointed to its session branch, then
the Allocation is released with reason `idle`. The next turn admits a fresh
Allocation in the same Environment and rehydrates the sandbox from the branch.
The agent worker sweeps each minute on the instance holding the node lease.
Nothing is released when the workspace could not be saved; a read-only
agent's workspace (0176) is released without saving, since its changes never
leave the sandbox. A released chat with queued work is admitted again wherever
it fits, even when the machine it left is gone. Capacity follows activity, not
open chats.

**Each workload is placed by its own Environment.** A workflow run uses its
enablement's Environment. A chat it delivers to uses the delivery's
`environment`, else the agent's `environment.preferred`, else the project
default. A chat's turns run as its owner, whoever delivered them: the
deliverer's access is checked when they deliver, and admission and connection
bindings are the owner's. Admission checks permission, not equality: the
chat's owner must be allowed the Environment under 0158 grants (a member through role
`environments`; a project chat, the project's own work, may use any Environment
the project declares) and the agent's `environment.allowed` must include it.
No new permission: reaching a project chat already needs a project automation
or `automations:write` (0156), and program authors choose agent policy.
Considered: a workflow-declared list of chat Environments shown at consent;
deferred because the agent definition's `allowed` already names them in
reviewed program, and a second list would drift from it. The chat records its
placement (Environment, the rule that chose it, machine).

**Machines can be opened to projects.** Worker `access` may name `projects`:
such a machine takes those projects' owner-less work (project chats and
automations) and never a member's chat. A machine opened to one project is its
narrowest tier and counts as serving one owner, so process isolation is enough.

## Consequences

A merge workflow calls `close({ key: "pr-42" })`; a reopened pull request starts
a fresh chat. A dedicated review pool needs a labelled worker opened to the
project and an agent that prefers it; control-plane machines stay unlabelled.
Consented connections are bound to the enablement's Environment, so a chat
placed elsewhere does not carry them; session-bound grants are follow-up work.
ADR 0181: a project chat uses its own Environment's service bindings.
Background processes in an idle chat stop when its workspace is released.
