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
  threads already carry (ADR 0198): kept for the turns that ran on it,
  never bound again. The next attempt on that harness starts a thread of
  its own and is handed the whole conversation, as a new thread always is.
- **The turn runs once more.** An attempt that reports it, then fails
  before beginning the turn (no `turn.started`), is followed by another
  attempt of the same turn (`retry`) on a new thread, with the full
  handoff. The failed attempt keeps its error, and a `thread_lost` notice
  says the agent starts over with the conversation so far, with the
  harness's reason in its data. Once per turn: never after an earlier
  attempt of it failed, so a harness that loses every thread fails the turn
  rather than looping. A person's stop meanwhile ends the turn as it
  failed.
- **Reported later** (after the turn began, or with an interrupt), the
  thread is still never resumed again: the turn ends as it does, and the
  next one starts a new thread with the full handoff.
- **The ACP adapter reports it** when the agent refuses `session/resume`
  or `session/load`, or no longer offers either for a session it was given,
  then fails the attempt without opening a session.

Considered: the adapter replacing the session itself (ADR 0241's first
answer), which cannot reach the conversation; a thread with its native ref
cleared, which loses the record of what ran on it; a harness-requested
restart that keeps the thread, which would resume the same dead ref.

## Consequences

An agent whose session is gone picks the chat up from the conversation in
the same turn, and the person sees why. Any harness can report it; today
only `@catamorphic/acp` does. The runner protocol gains one event; a host
that does not know it ignores it and fails the turn as before.
