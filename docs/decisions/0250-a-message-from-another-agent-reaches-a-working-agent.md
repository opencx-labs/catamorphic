# 0250 — A message from another agent reaches a working agent

- **Status:** Accepted (extends [0240](0240-a-message-sent-while-the-agent-works-reaches-it.md) to messages between agents; parent delivery rule superseded by [0278](0278-subagent-updates-reach-the-turn-and-read-as-activity.md))
- **Date:** 2026-10-19

## Context

ADR 0240 made a person's message and a task notification reach the
working turn at its next step. Messages between agents were left as they
were: `send_project_session_message` offered `message_only` (context that
starts no work), `queue` (a turn after the current one) and `interrupt`.
An agent that needed an answer had no way to say "read this now" short of
stopping the other agent, so it chose `queue`.

In a person's chat, a lead agent waited on its poster subagent while the
subagent sent it a question with `queue`. The question became a turn
behind the lead's, which ran on for hours (the person's own "send now"
message had also jumped ahead of it). The lead learned of the question
only by reading the subagent's chat; had it waited for the subagent, each
would have waited on the other.

## Decision

**Steering is the default between agents too.** `send_project_session_message`
takes `steer`, its default: the other agent reads the message at its next
step while it works, or it starts a turn when the agent is idle, as a
person's send does. `message_only`, `queue` and `interrupt` keep their
meanings; the tool says `queue` waits for the other agent's current turn
to end, however long that is.

**A subagent reaches its parent.** Core delivers a subagent's message to its
own parent session (`parent_session_id`) as `steer` when it is sent to
`queue`, for any host and whatever the tool asked: the parent coordinates
its subagents, and its results already steer into its turn (ADR 0202). A
turn that cannot take it in (one on its owner's sign-in, ADR 0199) still
runs it as a turn of its own, and `message_only` and `interrupt` are kept.

Considered: changing `queue` itself to steer for every agent message,
which takes away a real choice (work for after the current one); only
rewording the tool, which leaves a subagent that picks `queue` able to
deadlock with a parent that waits on it.

## Consequences

An agent asked a question while it works sees it at its next step, as with
a person's message. A message that must wait for a turn to end says so
with `queue`, and one a subagent sends its parent never does. The desktop's
agent guidance (`workspace-skill.ts`) teaches the modes.
