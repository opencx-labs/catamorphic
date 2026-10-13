# 0228 — A sign-in that can still refresh is retried, and a fixed one runs the turn again

- **Status:** Accepted (amends [0222](0222-desktop-harnesses-stay-warm-between-turns.md))
- **Date:** 2026-10-13

## Context

A person came back to a chat after an hour; its warm Claude Code had
closed, so the turn started a new CLI, which was turned away three
seconds in: "401 OAuth access token has expired". Work showed the
sign-in card. The login was fine: its refresh token had days left, and
the same CLI refreshed it a few minutes later. Claude Code refreshes an
expired access token under a lock every Claude Code on the machine
shares; a CLI that finds it busy too long (other terminal sessions) or
loses the refresh to the network goes on with the expired token. A
second try moments later would have worked.

The card also promised "your message retries by itself once you're
back", which only held when the person clicked Work's own re-login. A
sign-in renewed any other way (another process refreshing it, `/login`
in a terminal, a new key in Settings) left the failed turn where it was.

## Decision

**One quiet retry, decided by the host.** Core's turn engine retries
rate limits and outages itself. For any other failure nothing ran in
(`retrySafe`), it asks the agent's host, through
`RegisteredCodingAgent.retryFailure`, whether the failure is passing.
The host answers from what the error cannot say: the desktop reads the
agent's own Claude Code or Codex sign-in on this machine and asks for one
more attempt, after 3 s, when it can still refresh (a refresh token
present and unexpired). The turn stays active meanwhile ("Reconnecting
to Claude…"), the failed attempt keeps its error, a stop during the
pause ends the turn, a lost lease lets it go at once for the next holder,
and the retry is a new attempt on a fresh CLI (a failed turn ends its
harness, 0222). Core waits a minute at most, whatever the host answers.
It happens at most once per turn: never after an earlier attempt of the
turn failed, so a retry by hand or after a sign-in is not retried
quietly again. A sign-in that cannot refresh fails at once, as before.
The retry's Claude Code writes a debug log to `sign-in/` under Work's
logs (only this user can read it, the newest five kept), for whoever
diagnoses the next failure; Work never reads or sends it. A CLI writing
a debug log is never kept warm: it ends with its attempt, so the log
covers the retry alone, and the chat's next turn starts a new CLI once
(a few seconds) instead of reusing one that would keep logging.

**A fixed sign-in runs the failed turn again.** The desktop tracks each
chat whose latest turn failed on its sign-in (from settled turns, and
from the chat when it shows one, from before this run or forgotten). It
runs that turn again, as the person's Retry does, when Work's re-login
finishes, when the agent's key or sign-in mode changes in Settings, or
when the agent's credentials change to a usable state outside Work. A
turn seen failing as it settles also runs again when the sign-in holds
an access token more than five minutes from expiring: another Claude
Code may have refreshed it between the failed attempt and that look, so
no change would follow. A failure a chat shows from before waits for a
change, so opening an old chat does not run it. Main looks every 5 s for
10 minutes after it sees the failure, then whenever a window gains focus
or the machine wakes, and forgets the failure 30 minutes after seeing
it; a chat showing it again, or the person starting Work's re-login from
it, tracks it anew. Each cue runs a failed turn once, at most three
times per turn (Work's own re-login runs it even then); a turn that ran
three times is not looked at until its chat moves on (or for a day).
Only a top-level
chat the person keeps (active, not archived, not a subsession, not
continued on a server) runs again by itself, only a turn that ran the
person's own message (not a workflow's, an automation's or another
agent's), and only while it is still its chat's latest: core checks that
in the retry's own transaction, so a message sent meanwhile is never
overtaken. This works for chats that are not on screen.

## Consequences

The common case of a lost refresh is invisible to the person. A sign-in
revoked before its refresh token expires costs one extra attempt (3 s)
before the card, and, while its access token still looks fresh, up to
three more runs a few seconds apart before the card stays; an expired
one fails as fast as before. Hosts
without a judgment of their own keep today's behavior. On macOS a Claude
Code agent signed in on its own home (`account`) keeps its login in the
Keychain where Work does not look, so it gets no quiet retry, and only
Work's own re-login or a Settings change runs its failed turns again.
Servers can answer the same hook for their sandboxed harnesses later.
