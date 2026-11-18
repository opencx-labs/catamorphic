# 0333: A turn that stops making progress is visible, an event, and restartable

- **Status:** Accepted (amends 0198, 0245, 0328; amended by [0335](0335-disk-is-a-resource-work-manages-on-machines.md): a failed attempt's diagnostics say when the machine ran out of disk)
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
call, an acknowledgement) except a `diagnostic` event, each model request the
gateway passes on the attempt's grant (once per call, after its path, policy
and guards passed; one write a second at most), and the turn starting or
ending a wait on a person, which that wait's length never counts against. Diagnostics are log lines, not work. The turn's `activityAt` stays
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
than its threshold, while no working turn of its subsessions at any depth
(ADR 0322, shared or own workspace) made progress within that threshold
either, gets `stalled_at`, set by one conditional update over a recursive
walk of the session family, and a
`session.turn-stalled` session event with `payload.session.key` and
`detail: { turnId, attemptId, attempt, attempts, restarts, progressAt,
stalledAt, stallMinutes, activity }`. Progress clears `stalled_at`; a later
silence records it again. Work does not act on a stall.

**Restart is one operation.** `host["catamorphic.sessions"].restart({
sessionId | key, turnId, attemptId, reason, onlyIfStalled?, idempotencyKey
})`, the `session_restart` MCP tool and `POST
…/agent/sessions/:sessionId/turns/:turnId/restart` are one session action,
with the authority that interrupts the chat. It ends only the attempt it
names, while that is the turn's running attempt (and, with `onlyIfStalled`,
while it is stalled), so a request about an attempt that moved on, or one
replaced by another restart, ends nothing. A refusal is an answer, not an
error (`{ restarted: false, refused: "not_running" | "not_current" |
"not_stalled" }`; 409 over REST), so a workflow treats it as nothing to do. A
restart answers `{ restarted: true, turnId, attemptId, attempt, attempts,
restarts }`; the same key answers the same. It queues a `restart` turn
command for that attempt. The lease holder, on any replica, first checks it
still owns the turn and, for `onlyIfStalled`, that the attempt is still
stalled (else the command is dropped and the attempt runs on); then, without
asking the harness, the attempt is `restarted` with the reason, its model
grants are revoked, its open tool calls and requests close as unanswerable,
carried steers and interrupts are dropped, and a `turn_restarted` notice
names the reason. Only then is its runner ended: asked to stop (a sandbox
runner stops its harness, and an agent in its own process group, before it
exits), and its process group killed if it has not exited after 10 seconds.
A harness that starts a process in a group of its own (the ACP adapter's
agent) reports it as a `process.group` runner event, recorded on the
attempt; those groups are killed too, after the runner exits or with its
group, and once more after a final 5 seconds if it was never seen to exit,
so nothing of the old attempt runs beside the next, which starts only then.
A group id is a process id the system may reuse once its group ended. In a
sandbox of its own the only processes are the chat's; on hosts that run
harnesses beside other processes (local-process, in-process runners on the
desktop), a group that ended on its own could, in the seconds before the
kill, have had its number reused by an unrelated process group, which the
kill would then end. The window is the restart's few seconds, and reuse of a
just-freed number is rare; it is accepted rather than tracking each group's
start time. A holder that
finds the runner already gone (taken over, or exited) carries out a pending
restart instead of losing the attempt. The same turn then
runs a new attempt with reason `restart`, bound as every attempt is (ADR
0198): it resumes the thread when the harness can, told the attempt was
stopped and to check what was already done first; otherwise a new thread is
handed the conversation, including what earlier attempts of this turn
submitted (ADR 0328), and a thread found gone starts over once (ADR 0245).
A restart is not a lost runner: the turn is not interrupted, no continuation
turn is queued, and `recovery: stop` does not prevent it, since someone
asked for it. `interrupt` takes an optional `turnId` too, stopping that turn
only.

**Diagnostics survive.** Every attempt keeps, with its record, the last
16,000 characters of its runner's own output that is not a frame (a crash
trace, a warning) and of its harness's own log: `diagnostic` events, which
the Claude Code, Codex and ACP adapters now send, at most once a second, as
the CLI or agent writes to stderr. A runner ended from outside (SIGTERM) now
stops its harness first, so an agent in a process group of its own (ACP)
does not outlive it. Both are masked by every secret value the chat received (ADR
0206) before they are written, and nothing is cut inside a line before that:
a line too long to keep is left out whole, and a burst keeps its newest whole
lines, so no cut can keep part of a secret no mask matches. They are dropped
when the attempt completes. A
failed, interrupted, lost, superseded or restarted attempt keeps them.
`host["catamorphic.sessions"].attempts({ sessionId | key, turnId })` (MCP
`session_attempts`, `GET …/turns/:turnId/attempts`) reads a turn's attempts
with their diagnostics, for anyone who may read the chat. They are the
evidence to keep: Work wrote them from the runner's own output. A command
run in the chat's workspace (`exec`, ADR 0324) is not: code the chat runs can
forge what it prints, and commands may run apart from the agent (ADR 0332),
where they see neither its processes nor its logs.

**Recipe.** The `pull-request-reviews` pack ships an optional
`restartStalledReviews` workflow: on `session.turn-stalled` for this
repository's review chats exactly (the key and the chat's owner, agent,
Environment and starting workflow, as the poster checks), it reads the turn's
attempts with their diagnostics, stores them in the project store under the
pull request's number, inspects the chat again, and
restarts the stalled attempt only while it still is; after two restarts of a
turn it stops that turn, and the poster marks the commit `action_required`
unless the turn had already submitted its review for the head, which it
publishes. The reviewer's definition sets a stall threshold.

Considered: reusing `activityAt` (it moves only when the line changes);
counting diagnostics as progress (a harness retrying in a loop logs while it
does nothing); Work restarting stalled turns itself (whether a silence is a
hang is the project's call); counting only the attempt's own progress (a
coordinator waiting on subagents that work would be restarted mid-review);
marking a restarted attempt `lost` and queuing a continuation turn (the turn
would end interrupted, and `recovery: stop` would refuse what a person
asked); stalls while waiting on a person (that wait is the person's).

## Consequences

A hung turn is noticed within its threshold plus one worker poll, shows what
it was doing, and is restarted by project code with its evidence kept. Every
frame batch and admitted model call writes one column. A coordinator stalls
only once its whole family is silent; a subsession stalls on its own
threshold, if its agent sets one. A host tool waiting longer than the
threshold on something other than subsessions (a long external wait) reads
as a stall; the event's `activity` names it, so a recipe can skip it. Diagnostics streamed
from adapters add frames but never transcript items. Item A's separately run
commands (ADR 0332) count as progress only through the frames they cause.
