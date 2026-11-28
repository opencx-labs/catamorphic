# 0352 — An opened request is a session event, and a project's automations answer an unattended chat's approvals

- **Status:** Proposed
- **Date:** 2026-11-25
- **Amends:** 0054, 0138, 0176, 0181
- **Amended by:** [0355](0355-hooks-are-triggers-a-waited-event-and-setup-asks-before-it-replaces.md): setup no longer names a workflow either, and an event's emitter can wait for the runs it starts

## Context

An approval in a chat no one watches is refused at once unless the automation
that delivers into it named approvers (ADR 0176), and approvers are people. A
server whose chats nobody follows (a pull request reviewer that reports on
GitHub) therefore had no way to let anything through: an ACP agent's own
permission prompt was refused within a second, the agent ended its prompt, and
the turn completed with no result. The project worked around it in the
harness's configuration, which is all or nothing and lives in an image.

Session changes are typed Project Events, and workflows act on chats with
shared session operations, `answer` among them (ADR 0138). A request opening
was the one change of a chat's state that published no event, so a workflow
could neither see one nor be the reason it stays open.

## Decision

**`session.request-opened`.** When an agent asks for something its turn waits
on (an approval from a tool policy set to ask, a harness's own permission
prompt, a guard's escalation; a question; an elicitation), core records a
session event in the transaction that opens the request, with the chat's
snapshot as every session event carries it and, in `detail`, `requestId`,
`kind`, `blocking`, `title`, `description`, `origin`, `approval { action,
details, tool { server, name, input } }`, `questions`, `elicitation`,
`turnId`, `attemptId` and `expiresAt`. A workflow bound to it answers with
`sessions.answer`. A request refused at once records none.

**A project automation that listens is someone who can answer.** When an
approval opens in an unattended chat, core asks whether an active
project-owned enablement is bound to the event for it, matching the trigger's
config and `where` exactly as a dispatch does, in the same transaction. If one
is, the approval waits instead of being refused: for
`approvals.waitMinutes` when the Environment sets it, else two minutes when no
person approves there (a workflow answers in seconds, and one that does not is
not worth half an hour of a turn), else as long as it waits for its people. A
member's own automation never counts: it acts for one person.

**Who answers an unattended chat's approval.** Its named approvers, as before,
and the project's own automations (the project principal, where it may change
the chat). A member who can merely continue the chat cannot. Questions and
elicitations keep their rule.

**Subsessions are covered by the event, not by inheritance.** Each
subsession's request is its own event, and a binding with no `sessionId` hears
the whole project, so a coordinator's children wait for the same workflow.

Considered: synchronous "decision" trigger kinds whose workflow returns the
answer (a second firing model with its own timeout and default, when a request
is already a durable thing that waits and has an answer operation); naming a
workflow as an approver on `deliver`, or on the Environment as setup does (a
second place subscriptions live, against ADR 0039, and children would need
inheritance); a marker for the project among a request's `approvers` (clients
show that list as people's names). Not decided here: a synchronous check on a
submitted result, which has no durable request to wait on.

## Consequences

Approval policy for unattended agents is project code: TypeScript over the
tool and its input, consented with the workflow's enablement (binding the
event is in its authority digest, ADR 0330), deployed by merging. A workflow
must answer what it hears, denied with a reason when it should not run, or the
turn waits out the request's expiry. `tool.input` is written by an agent that
may have read untrusted content, so a workflow approves exact tools and
arguments. Host `connectionGuards` (ADR 0183) are unchanged: they decide
before a request exists and still escalate into one. Clients show such a
request like any pending approval; a member who presses approve is told only
the chat's approvers can answer.
