# 0156 — Team automations, webhooks, and command watches

- **Status:** Accepted
- **Date:** 2026-09-23
- **Supersedes:** 0087 (member-only wake)
- **Refines:** 0068, 0074, 0138, 0148, 0155

## Context

Automations could only belong to one member. A "service" owner existed, but its
runs executed as whoever created it, its connection was a single column, and
its wakes had nobody to reach: 0087 made `wake` member-only. Outside services
could not start a workflow at all (no webhooks), and project secrets never
reached runs without a plugin resolver. Brain servers only dispatched events
when coding agents were configured. Agents that wanted to wait for a deploy or a
file wrote sleep loops, or a workflow whose isolated checkout could not see the
person's files or localhost.

## Decision

**An enablement belongs to a member or to the team.** `owner: { type: "team" }`
replaces the service owner. A team enablement runs as the project's team
principal (`catamorphic:team`): project scope, the enablement's Environment, and
its non-member connections (unattended admission already refuses personal ones).
Builders and holders of `connections:manage_service` enable and manage team
automations; every member sees them. The list reports `canManageTeam` so a host
offers the choice only to those who may use it.

**Wakes follow the enablement.** A member's enablement wakes that member's chat.
A team enablement wakes a **team chat** by default: a session owned by the team
principal that everyone whose role reaches its agent can read and continue, or
one member's chat with `audience: { member }`. An ad hoc run can wake the caller,
or the team when the caller is a builder. Team chats carry `owner: "team"` so
clients mark them. Alternatives: per-member fan-out (N copies of one PR review,
no shared thread) and a notification inbox (0087 rejected it) both lost.

**Webhooks are a trigger kind on brain servers**, not a session feature.
`trigger("webhook", { name, verify? })` gives the project one public URL per
name, `POST /hooks/<project>/<name>/<token>`: the token is the credential and
can be rotated; an optional HMAC-SHA256 check reads a project secret. A request
is stored as a Project Event (deduplicated by the sender's delivery id), answered
202, and dispatched to every active bound workflow, which may wake a chat.
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

- PR reviews, inbound requests and shared inboxes become one team chat each,
  keyed by the event, that any teammate can open and continue.
- The desktop only receives webhooks a sender can reach; hosts that are online
  (the stock server) are where webhook automations belong, and its URLs use the
  configured public base.
- Session watchers (`create_watcher`) stay for Project Events and workflow IO;
  `watch_command` covers shell checks. Both wake through core's `deliver`.
