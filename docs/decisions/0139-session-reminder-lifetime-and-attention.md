# 0139: Session reminder lifetime and message attention

- **Status:** Accepted
- **Date:** 2026-09-14
- **Refines:** 0138, 0077, 0124
- **Supersedes in part:** 0074 and 0076 (watcher lifetime and placement)

## Context

A reminder requested for seven days later must survive closing the chat and months
offline. Archiving should have an explicit, predictable effect. Separate message
and notification operations make retries and navigation ambiguous.

## Decision

Temporary means owned by a session, not short lived. Watchers have no implicit
expiry. An explicit expiry remains available. One-shot schedules preserve their
original deadline and run once when their host returns. Session-owned workflows
remain on the session's authoritative host and use its Environment; local reminders
do not transfer to a remote server when the desktop stops.

Archiving cancels active and paused watchers across the session tree. Confirmation
lists their names and next scheduled times. Restoring the session does not restart
them. Closing a tab leaves them enabled; delivered history and run evidence remain.

Session delivery accepts attention independently of execution mode. A reminder is
an attributed message_only delivery with attention required. Message insertion,
attention revision and notification outbox insertion share one transaction and
idempotency key. Notification transports link to that message. The separate notify
operation is removed. Preferences control alerts, not retained messages.

## Consequences

Skills distinguish agent wakeups from user reminders and explain offline execution
and archive cancellation. Clients show linked provenance and late delivery times,
with durable unread attention and precise notification navigation. Tests cover
months offline, concurrent retries, remote mailbox delivery and archive confirmation.
