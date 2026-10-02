# 0196 — Agent sessions are an event log of turns

- **Status:** Accepted
- **Date:** 2026-10-02
- **Supersedes:** [0061](0061-session-mirroring.md) (mirror transport), the
  event and command half of [0095](0095-authoritative-agent-execution.md)
- **Amends:** [0074](0074-durable-session-inbox.md), [0090](0090-first-class-subsessions-and-delegation.md), [0193](0193-no-cross-replica-state-in-replica-memory.md)

## Context

A session's live state was one mutable placeholder message rewritten on
every provider event (`metadata.events`), and clients polled the whole
transcript every 500 ms. Nothing was sequenced, so nothing could stream,
resume, replicate, or be replayed in a test. Only `send` was idempotent.
A sandbox `agent_runtime_events` log and a second harness contract were
built for this and never wired in. T3 Code's orchestrator v2 reached the
same diagnosis and the same model.

## Decision

**One model.** A session is the conversation; a subsession is a session
with a parent, nothing more. A **turn** is one counted unit of work: its
input, the work, and the settled answer. A turn has one or more
**attempts** (`initial`, `retry`, `steer_restart`, `recovery`): only the
final attempt settles it. **Items** are the ordered transcript: user and
assistant messages, reasoning, tool calls, commands, file changes, plans,
requests, subagent links (to the child session), notices and handoffs.
Work owns every id; a provider's ids are references with a strength
(`strong`, `weak`, `none`) on items, attempts and **provider threads** (the
native conversation a turn ran on). Only a turn's own root completion
settles it; a subagent or tool finishing never does.

**An event log, committed with its projections.** Every change to a
session's turns, attempts, items, requests and visible fields is an event
in `agent_session_events` with a per-session `sequence`, allocated under
the session row lock. The events and the tables they project
(`agent_turns`, `agent_turn_attempts`, `agent_items`,
`agent_runtime_requests`, `agent_provider_threads`) commit in one
transaction through one writer, `SessionLog.append`. Events carry the
changed entity, plus `item.text_appended` for streamed text, so a client
applies them with a pure reducer shared with the server
(`@catamorphic/agent-protocol`). Events carry only protocol fields: engine
state such as a runner's location stays in its own columns. Folding the log
gives the projections exactly, and a test asserts it.

**Commands are idempotent.** Every mutating turn operation (send, steer,
queue edits, send now, interrupt, retry, answer, respond, roll back) carries
a client `commandId`. `agent_session_commands` stores the receipt: status,
the last sequence it committed, and its result or refusal. A repeated
command returns the same receipt and runs nothing. Clients generate ids and
retry with the same id; mobile outboxes resend until a receipt arrives.

**Snapshot plus cursor.** `GET …/sessions/:id` returns a bounded snapshot
(recent turns and items) with its `sequence`. `GET …/sessions/:id/events?
after=N` streams later events as server-sent events. A gap larger than 256
events or 1 MiB answers `reset` with a fresh snapshot instead. Each replica
runs one feed poller for all open streams (one query per tick over the
subscribed sessions' cursors, no LISTEN/NOTIFY, per 0193); a stream that
falls 1,000 events or 8 MiB behind is closed and the client resumes from its
cursor. Older history pages by item sequence.

**Dispatch.** A message is `queue` (a new turn after the active one),
`steer` (into the active turn: natively when the harness can, else as a
`steer_restart` attempt of the same turn), `interrupt` (stop the active
turn, then run this), or `message_only` (attributed delivery, no turn).

**Replication is the log.** A desktop mirrors a session to its remote by
pushing events after the remote's acknowledged sequence; the remote applies
them through the same projector. Authority still moves only by the 0077
compare-and-swap, so a mirror never dispatches. The source's provider
threads arrive as unavailable (their native state lives on the source's
machine), so a copy that continues the session starts a thread of its own
and is handed the history (ADR 0197).

**Rollback and fork use the same records.** Each turn records the
checkpoint before and after it. `rollback({ turnId })` restores the
workspace to before that turn in a checkout the session owns, marks it and
later turns `rolled_back`, and rewinds the provider thread natively or
replaces it with a handoff. A fork copies the settled turns and items
through a message into a session of its own, with fresh ids, and its first
turn forks the native thread through that turn when the harness can.

Considered: keeping messages and adding a log beside them (two sources of
truth); domain events reduced into projections by a separate process (a
second consistency boundary for no gain at our scale).

**Replies around questions (0195) are dispatch rules.** A person's message
sent while the turn waits on a question steers into that turn: the waiting
call is released with a reason (the runner's `release` command) and the
question stays open as non-blocking, whose answer later arrives as a
message; a waiting approval is withdrawn as declined. `close_questions` is a
Work tool every agent gets.

## Consequences

Clients stream instead of polling and resume after any disconnect. Mirrors
send deltas. Every behavior is testable from recorded provider transcripts
through real persistence (ADR 0197). `agent_messages` and the old turn
queue columns are gone; a forward migration converts existing sessions.
The session service splits into the log, the turn queue, the turn driver,
preparation, finalization, provider threads and read models.
