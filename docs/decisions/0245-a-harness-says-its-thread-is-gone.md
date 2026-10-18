# 0245 — A harness says its thread is gone

- **Status:** Accepted (amends 0198, 0241)
- **Date:** 2026-10-18

## Context

A turn resumes its session's native thread when the thread has one
(ADR 0198), and Work hands it only the turns it missed. When the thread
can no longer be reopened (an ACP agent whose session was deleted or
pruned, an agent that stopped offering `session/load`), the harness had no
way to say so. ADR 0241's adapter replaced the session with a new one,
which went on without the earlier conversation, and every later turn
resumed that new session, missing turns 1 to N-1 for good.

## Decision

A harness reports `{ type: "thread.lost", reason }` when the thread its
attempt was bound to resume is gone.

- **Core marks the thread `unavailable`,** the status a copied session's
  threads already carry (ADR 0197): kept for the turns that ran on it,
  never bound or revived again (a `thread` event after it is ignored). The
  next attempt on that harness starts a thread of its own and is handed
  the whole conversation, as a new thread always is.
- **The turn runs once more.** An attempt that reports it, then fails
  before beginning the turn (no `turn.started`), is followed by another
  attempt of the same turn (`retry`) on a new thread, with the full
  handoff. The failed attempt keeps its error; a `thread_lost` notice says
  the agent starts over, with the harness's reason in its data; interrupts
  and steers meant for the failed attempt are dropped, as for a steer
  restart, since the new prompt carries every message. Once per turn: a
  thread lost again in it fails the turn. A person's stop ends the turn.
- **Reported later** (after the turn began, or with an interrupt), the
  thread is still never resumed: the turn ends as it does, and the next
  one starts a new thread with the full handoff.
- **The ACP adapter reports it only for an answer that the session is
  gone:** a refusal of `session/load` or `session/resume` as not found,
  invalid params or method not found (or a message saying so), an agent
  that no longer offers either, or a load that replays nothing. It prefers
  `session/load`, whose replay proves the session is there: Work reports a
  session only once a turn ran on it, while Hermes answers a load of a
  session it lost with nothing and a resume by opening another under a new
  id. A crash, an interrupt, a sign-in or another error fails the turn and
  leaves the session to the next one.

Considered: the adapter replacing the session itself (ADR 0241's first
answer), which cannot reach the conversation; clearing the thread's native
ref, which loses the record of what ran on it; a harness-requested restart
that keeps the thread, which would resume the same dead ref; treating any
refused reopen as gone, which would abandon a good session over a passing
error.

## Consequences

An agent whose session is gone picks the chat up from the conversation in
the same turn, and the person sees why. An agent that loses its sessions
every time pays a second start and a full handoff each turn, and a turn
rebound after an earlier attempt of it began starts that turn over. Any
harness can report it; today only `@catamorphic/acp` does. The runner
protocol gains one event, additive, so its version stays. A core without
it would fail such a turn and every later one; ACP runs only beside its
own core today.
