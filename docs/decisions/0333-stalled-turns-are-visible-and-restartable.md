# 0333: A turn that stops making progress is visible, an event, and restartable

- **Status:** Accepted (amends 0198, 0245, 0328)
- **Date:** 2026-11-18

## Context

A production pull request reviewer's coordinator stopped making progress in
the middle of a turn, most likely in a hung tool call, while its machine
stayed healthy and kept heartbeating. Nothing noticed for 30 minutes, nobody
could see which call hung, and replacing the machine did not help. In Work a
lost runner is handled (ADR 0198: the attempt is lost and, with recovery
`continue`, the work continues), but a live runner whose harness is stuck is
not lost, so its turn would run forever. Workflows saw only a chat's
`updatedAt`, and the runner's and harness's own error output lived in replica
logs and harness memory, gone with the attempt.

## Decision

**Progress is a recorded time.** Each attempt records `progress_at`: when it
last made progress. Progress is any frame its runner sends (an event, a host
call, an acknowledgement) except a `diagnostic` event, and every model
request the gateway admits on the attempt's grant (one write a second at
most). Diagnostics are log lines, not work. The turn's `activityAt` stays
what it was: when its live line last changed. A chat as session `inspect` and
`find` return it to workflows, the session detail over REST, and the
`session_inspect` MCP tool carry `turn`, the turn working now (or null): its id, status,
attempt (id, ordinal, reason, started), `attempts` and `restarts` so far,
`progressAt`, `stalledAt`, `stallMinutes`, and what the attempt last
reported: tool calls and commands still in progress, with when each began.

**A stall is an event.** An agent definition may set `"stall": { "minutes":
20 }` (a whole number from 1 to 1440; absent, no stall is ever recorded);
host agents set the same field. The threshold is copied onto the attempt
when it starts. Work's agent worker, on every replica, records a stall once:
an attempt running (not waiting on a person) whose `progress_at` is older
than its threshold gets `stalled_at`, set by one conditional update, and a
`session.turn-stalled` session event with `payload.session.key` and
`detail: { turnId, attemptId, attempt, attempts, restarts, progressAt,
stalledAt, stallMinutes, activity }`. Progress clears `stalled_at`; a later
silence records it again. Work does not act on a stall.

**Restart is one operation.** `host["catamorphic.sessions"].restart({
sessionId | key, turnId, reason, idempotencyKey })`, the `session_restart`
MCP tool and `POST …/agent/sessions/:sessionId/turns/:turnId/restart` are one
session action, with the authority that interrupts the chat. It refuses a
turn that is not running or waiting, and answers `{ turnId, attemptId,
attempt, attempts, restarts }` naming the attempt it ends; the same key
answers the same. It queues a `restart` turn command for that attempt. The
lease holder, on any replica, ends the attempt without asking its harness:
the runner is killed (its process and the harness under it), the attempt is
`restarted` with the reason, its model grants are revoked, its open tool
calls and requests close as unanswerable, carried steers and interrupts are
dropped, and a `turn_restarted` notice names the reason. The same turn then
runs a new attempt with reason `restart`, bound as every attempt is (ADR
0198): it resumes the thread when the harness can, told the attempt was
stopped and to check what was already done first; otherwise a new thread is
handed the conversation, including what earlier attempts of this turn
submitted (ADR 0328), and a thread found gone starts over once (ADR 0245).
A restart is not a lost runner: the turn is not interrupted, no continuation
turn is queued, and `recovery: stop` does not prevent it, since someone
asked for it.

**Diagnostics survive.** Every attempt keeps, with its record, the last
16,000 characters of its runner's own output that is not a frame (a crash
trace, a warning) and of its harness's own log: `diagnostic` events, which
the Claude Code, Codex and ACP adapters now send, at most once a second, as
the CLI or agent writes to stderr. A runner ended from outside (SIGTERM) now
stops its harness first, so an agent in a process group of its own (ACP)
does not outlive it. Both are masked by every secret value the chat received (ADR
0206) before they are written, and dropped when the attempt completes. A
failed, interrupted, lost, superseded or restarted attempt keeps them.
`host["catamorphic.sessions"].attempts({ sessionId | key, turnId })` (MCP
`session_attempts`, `GET …/turns/:turnId/attempts`) reads a turn's attempts
with their diagnostics, for anyone who may read the chat. A workflow that
needs more (a process list, the harness's log files) runs `exec` (ADR 0324)
before restarting.

**Recipe.** The `pull-request-reviews` pack ships an optional
`restartStalledReviews` workflow: on `session.turn-stalled` for review chats,
it collects a process list and the harness's recent log with `exec`, stores
them in the project store beside the review, restarts the turn, and after
two restarts of a turn marks the review incomplete the way a failed turn
does. The reviewer's definition sets a stall threshold.

Considered: reusing `activityAt` (it moves only when the line changes);
counting diagnostics as progress (a harness retrying in a loop logs while it
does nothing); Work restarting stalled turns itself (whether a silence is a
hang is the project's call: a coordinator waiting on subagents is silent);
marking a restarted attempt `lost` and queuing a continuation turn (the turn
would end interrupted, and `recovery: stop` would refuse what a person
asked); stalls while waiting on a person (that wait is the person's).

## Consequences

A hung turn is noticed within its threshold plus one worker poll, shows what
it was doing, and is restarted by project code with its evidence kept. Every
frame batch and admitted model call writes one column. A host tool waiting
longer than the threshold (a long `wait_for_subsessions`) reads as a stall;
the event's `activity` names it, so a recipe can skip it. Diagnostics streamed
from adapters add frames but never transcript items. Item A's separately run
commands (ADR 0332) count as progress only through the frames they cause.
