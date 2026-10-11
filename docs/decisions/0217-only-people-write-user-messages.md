# 0217 — Only people write user messages

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [0074](0074-temporary-watchers-and-session-delivery.md) (attributed delivery), [0155](0155-shells-background-commands-and-live-status.md) (background command wakes), [0197](0197-agent-sessions-are-an-event-log-of-turns.md) (items, dispatch), [0216](0216-voice-local-speech-in-any-chat-and-the-assistant.md) (session notes)

## Context

Every input a session received was a `user_message` item with an author:
the person, another agent, a workflow, a watcher, or `system` with a code.
Consumers that meant "the person" treated them all alike. A background
command that kept printing a matching error stacked one queued turn per
wake, each shown in the queue as the person's editable bubble with the text
written for the model. Agents' and workflows' words named untitled chats,
filled the composer on undo, were labelled `Person:` in handoffs and `user`
in transcripts; `ask_agent` was recorded as the person outright. Inputs
delivered `message_only` never reached the model at all, though senders
relied on the agent reading them next turn. The model got a
`[Catamorphic … not written by the user]` prefix.

Claude Code, Codex, OpenCode and T3 Code all keep these apart: a typed
origin per input, the text the model reads beside one line for people,
separate envelopes for task notifications and agent messages, mid-turn
delivery at the next tool boundary, pending notifications batched into one
model call, and inputs that do not wake the agent riding along with its
next turn. OpenCode moved from flags on user messages to kinds of their own.

## Decision

**Three input kinds.** `user_message` is a person's, nothing else.
`inbound_message` is words someone else sent the chat, `from` an agent's
chat, a person's own assistant (an MCP client of the project, as
`ask_agent` is), or a workflow. `task_notification` is Work's report on a
task the agent started: a background command, a command watch, a
subsession, a chat it follows. It carries the task (type, id, title,
status: completed, failed, update, needs_input, stopped), a `summary` people
read, the `detail` the agent reads after it, and a `source` people open (a
chat, a workflow run, or a host surface such as a terminal). Every input
keeps dispatch, attention, idempotency and provenance. Session actions are
records, not inputs: notices naming who acted. Lines Work writes for people
stay notices. `deliver` maps an author onto the first two kinds; hosts and
core report tasks with `notify`; mailboxes carry the typed input.

**What the agent reads.** The person's words as they are. Anything else in
a tagged envelope that says it is not the person's and approves nothing:
`<agent-message>`, `<workflow-message>`, or `<task-notification>` with the
task's fields. Envelope tags inside delivered text are made inert.

**Delivery.** A task notification reaches the turn while it works (a native
steer at the harness's next boundary); while the turn waits on the person or
finalizes, or when nothing runs, it waits in the one turn queued for
notifications, which later ones join instead of queueing turns of their own.
A `message_only` input waits, `in_progress`, for the next turn, which reads
it before its own input; a turn on its owner's sign-in takes only the
owner's (ADR 0199). Inbound messages keep the sender's dispatch. A
background command reports a matching line once, however often it repeats.

**What people see.** Inbound messages and notifications are rows like a
turn's steps: an icon for the sender or task, its status, one line, a
chevron to the full message or the detail, and a link to the source. A
notification that reached a working turn is one of its steps; one that
started or waited for a turn heads it; repeats from one task fold into one
row. Queued, they are one quiet line that can be withdrawn or run now, never
edited. Only the person's messages name a chat, offer "Restore to here", or
come back with the up arrow.

Considered: one non-person kind with a typed origin (Claude Code's shape),
which leaves kind-specific fields in a union; keeping one input kind and
fixing each consumer, which leaves the next consumer to forget.

## Consequences

Item, transcript, handoff, mailbox and HTTP shapes change; migration 061
converts existing rows and mailbox deliveries. Workflow-facing
`session.message-received` events cover every input kind, with `inputKind`
in their detail. Clients render three kinds where there was one, from the
shared registry rows. Delivery into a running turn depends on the harness
steering natively, which all three do; a refused steer still runs after the
turn, joining the notifications waiting there.
