# 0156 — Project automations, one deliver, webhooks, and command watches

- **Status:** Accepted
- **Date:** 2026-09-23
- **Supersedes:** 0087 (member-only wake)
- **Refines:** 0068, 0074, 0138, 0148, 0155

## Context

Automations could only belong to one member. A "service" owner existed, but its
runs executed as whoever created it, its connection was a single column, and
its wakes had nobody to reach: 0087 made `wake` member-only. Workflows had two
verbs for reaching a chat, `deliver` (by id) and `wake` (by key). Outside services
could not start a workflow at all (no webhooks), and project secrets never
reached runs without a plugin resolver. Brain servers only dispatched events
when coding agents were configured. Agents that wanted to wait for a deploy or a
file wrote sleep loops, or a workflow whose isolated checkout could not see the
person's files or localhost.

## Decision

**An enablement belongs to a member or to the project.** `owner: { type:
"project" }` replaces the service owner. A project enablement runs as the
project principal (`catamorphic:project`): its own workflow, every project
agent, the enablement's Environment, its non-member connections (unattended
admission already refuses personal ones), and the permissions the workflow
declares ([0158](0158-project-permissions.md)). Holders of `automations:write`
enable and manage project automations; every member sees them. The list reports
`canManageProjectAutomations` so a host offers the choice only to those who may
use it. "Project", not "team": a project may be one person's brain as well as a
company's.

**One operation reaches a chat.** `catamorphic.sessions.deliver` names its chat
by `sessionId`, or by `key`: the chat this workflow keeps for that key, started
on first use and reused after (`agent_sessions.chat_key`). `mode` says what the
agent does (`next_turn` by default, `message_only`, `interrupt`). A keyed chat
alerts its people when the agent's turn settles; `notification` words that
alert and adds it to a chat named by id. The idempotency key defaults to one
delivery per run, chat and content. The separate `wake` operation is gone: it
was `deliver` plus find-or-create by key, and two verbs for one act made
workflows harder to write.

**Keyed chats follow the enablement.** A member's automation reaches that
member's chat. A project automation reaches a **project chat** by default: a
session owned by the project principal that everyone whose role reaches its
agent can read and continue, or one member's chat with `audience: { member }`.
A member's automation or a run started by hand reaches its caller; the
project chat with `automations:write`, or another member's chat with
`sessions:write`, each declared by the workflow (0158). Project chats carry `owner: "project"` so clients mark them.
Alternatives: per-member fan-out (N copies of one PR review, no shared thread)
and a notification inbox (0087 rejected it) both lost.

**Webhooks are a trigger kind on brain servers**, not a session feature.
`trigger("webhook", { name, verify? })` gives the project one public URL per
name, `POST /hooks/<project>/<name>/<token>`: the token is the credential and
can be rotated; an optional HMAC-SHA256 check reads a project secret. A request
is stored as a Project Event (deduplicated by the sender's delivery id), answered
202, and dispatched to every active bound workflow, which may deliver to a chat.
Bindings of one name must agree on `verify`. Bodies are capped at 1 MiB;
authorization and cookie headers are dropped.

**Every host dispatches events.** `core.dispatchEvents()` expires watchers and
delivers Project Events; `startEventDispatcher` runs it each second on the
desktop and the stock server, with or without coding agents. Declared secrets
reach every run.

**Command watches are host background work.** `watch_command` repeats a quick
check where the agent's commands run and wakes the chat once on success or on
every change of output or exit status. They are saved with the profile and
resume on start. Missed checks collapse into one immediate check against the
last output, so a change during sleep is reported once, never replayed; expiry
ends a watch with one message; archive stops it. A workflow was rejected for
this: its checkout (often a microVM) cannot see the working tree or localhost,
and the schedule, state and lifecycle it needed already exist in the host.

## Consequences

- PR reviews, inbound requests and shared inboxes become one project chat
  each, keyed by the event, that anyone in the project can open and continue.
- Group chats, where the agent may stay quiet while people talk, build on
  project chats (#92).
- The desktop only receives webhooks a sender can reach; hosts that are online
  (the stock server) are where webhook automations belong, and its URLs use the
  configured public base.
- Session watchers (`create_watcher`) stay for Project Events and workflow IO;
  `watch_command` covers shell checks. Both reach the chat through core's
  `deliver`.
