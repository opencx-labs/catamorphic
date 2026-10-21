# 0269 — A turn that failed on its sign-in while the person was away runs again when they return

- **Status:** Accepted (its diagnosis corrected by [0275](0275-a-resumed-claude-code-keeps-its-sign-in.md): the failures were resumed threads whose CLI could not refresh)
- **Date:** 2026-10-20
- **Amends:** [0228](0228-a-sign-in-that-can-still-refresh-is-retried.md)

## Context

A chat's background command and CI watch finished overnight, at 5 AM,
and each woke the chat. Its Claude Code was turned away with "OAuth access
token has expired", twice, and Work's quiet retry 3 s later (0228) was too.
Their debug logs show no refresh attempt: every Claude Code on the machine
woke to renew the same expired token at once, and these lost. The login
was fine. In the morning the sign-in card was still there. Under 0228 the
turn could not run again by itself: it ran a task notification, not the
person's message, and its failure was forgotten 30 minutes after it was
seen, hours before the person came back.

## Decision

**A turn a chat's own task started runs again too.** Besides the person's
own message, a turn that ran a task notification (ADR 0217: a background
command, a watch, a subsession, a chat it follows) may run again once its
sign-in works. A workflow's, an automation's or another agent's message
still never does.

**Nothing is forgotten while the person is away.** The machine sleeping or
its screen locking marks them away (`SignInRecovery.left`); waking or
unlocking marks them back (`returned`). While away, no failure is
forgotten. On return every failure is watched as if just seen: looked at
every few seconds for 10 minutes, forgotten 30 minutes later. A failure
seen settling here runs again then if its sign-in can still refresh (a
refresh token present and unexpired), with no change needed: a new Claude
Code renews an expired access token itself. A failure a chat shows from
before still waits for a change. The three-runs cap and every other rule
of 0228 stand.

## Consequences

- After a night away the failed turns run again within seconds of the
  person unlocking their Mac, and the cards go.
- A return costs at most one more attempt per failed turn when the renewal
  still fails; the card then stays until the sign-in changes or the person
  retries.
- A screen left unlocked while away does not count as away; its failures
  are forgotten after 30 minutes, as before.
