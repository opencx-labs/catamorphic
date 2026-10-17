# 0240 — A message sent while the agent works reaches it

- **Status:** Accepted (amends [0197](0197-agent-sessions-are-an-event-log-of-turns.md) and [0217](0217-only-people-write-user-messages.md))
- **Date:** 2026-10-17

## Context

A person's message sent while the agent worked waited in the queue for
the whole turn to end. The only way to reach the agent sooner was "send
now", which stopped the turn. People sent now to ask a quick question,
and the agent lost its place. The Claude Code app does the opposite: the
message is sent, the agent reads it at its next step, and stopping for it
is still offered on the message.

Task notifications had the same shape. One that arrived while the turn
waited on the person, or one a stopped turn had not read, waited in a
turn of its own behind whatever ran next, and was shown as queued while
the agent worked. A Claude Code CLI kept warm between turns (ADR 0222)
also kept such a steer in its own input queue after an interrupt and ran
it in its next turn, so the agent read it there while Work still held it
as a queued turn to run again.

## Decision

**Steering is the default.** A `send` without `dispatch` steers: into the
working turn when one runs, else it starts a turn. `queue` is a choice a
client makes (the desktop's "Queue messages sent while the agent works",
off by default); `interrupt` still stops the turn and runs the message
next.

**Unread until read.** A steered input is `in_progress` until the harness
takes it in (`input.consumed`), then `completed`. Clients show the
person's message in the conversation at once, marked not read yet. An
attempt that starts while some are unread (its turn was preparing, or it
retries after a rate limit) carries them in its prompt; a turn that ends,
or is stopped while it waits to retry, runs them as turns of their own. A
harness reports one read only once it is on the thread the next turn
resumes.

**Read it now.** `steer_now { itemId }` stops the working attempt and
starts the turn again on the same thread with what it had not read, the
restart a refused steer already used (`steer_restart`). It is offered on
the person's unread message while the turn runs or waits, and every
message the turn had not read then is read with it. A message read
meanwhile, or a turn not working, has nothing to stop for: the command is
accepted and changes nothing. A restart carries what no thread took in
(what an attempt whose harness never began carried counts as not taken),
and with nothing left tells the agent to carry on, never its input again;
when no attempt's harness began the turn (`turn.started`), the turn's
input starts over with what was steered. A harness waits for its own
input to be sent before it takes a steer, rather than refusing one.

**Notifications reach the turn.** A task notification steers into any
turn that has not finished its work (waiting on the person included); a
turn's first attempt takes in the notifications waiting in a turn of
their own, under the session's lock, and their turn is withdrawn. A
notification waits for a turn only while nothing runs or the turn
finalizes. A prompt reads its inputs in the order they came, as the
conversation shows them.

**An interrupt withdraws what the harness holds.** The Claude Code
adapter interrupts with `cancel_queued` (the CLI's
`interrupt_cancel_queued_v1`), so a steer Work runs again (a restart's
prompt, a turn of its own) is never also run by the warm CLI; a CLI that
still holds one after an interrupt (one too old to withdraw it) is ended,
not kept warm. The CLI's own queued background notifications go with
them. Codex drops a steer it had not taken when its turn is interrupted,
which a native test checks.

Considered: keeping queue as the default and making "send now" softer
(steer instead of stop), which leaves the common case waiting; a native
"read now" per harness (Claude Code's `priority: "now"`), which needs a
fallback anyway and the restart already works on every harness.

## Consequences

A message sent while the agent works no longer starts a turn of its own,
and edits before it runs are only for queued messages. `steer_now` is a
new session command, and an `in_progress` user message is new for
clients that assumed inputs were always settled. Embedders that relied on
the queue default pass `dispatch: "queue"`; a send that moves the
workspace, and `sendMessage`, which answers with its own turn's reply,
still queue by default. A person's Stop still runs unread messages and
notifications as turns of their own after it.
