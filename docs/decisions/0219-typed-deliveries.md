# 0219 — Deliveries are typed

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [0217](0217-only-people-write-user-messages.md) (delivery fields), [0199](0199-subscription-sign-ins-stay-on-the-machine.md) (how authorship crosses hosts), [0090](0090-first-class-subsessions-and-delegation.md) (causation)

## Context

Every input carried a free-form `metadata` object that core, the database
trigger and clients read by string key: who delivered it (`deliveredBy`,
the basis of ADR 0199's owner-only turns), the automations that led to it
(`causation`, how loops stop), a workflow run's `provenance`, a person's
answer to questions (`questionRequestId`, `question`), a workflow's
`workflowNotification`. Mailbox rows added more keys only the destination
read: `ownerAuthored`, `attention`, and a forwarded session action dressed
as a message (`sessionAction`). Each reader re-validated by hand; a typo or
a forgotten key failed silently.

## Decision

**No free-form metadata.** An input's delivery facts are fields of every
input item: `deliveredBy` (the member whose call delivered it, or null) and
`causation` (enablement ids, oldest first), beside `dispatch`, `attention`
and `idempotencyKey`. What belongs to one kind is that kind's field: a
person's answer is `answer` (the request, its questions, the answers) on
their message; a workflow's ask to tell people when its turn settles is
`alert` on its inbound message. A run's circumstances describe the sender,
so a workflow sender carries `enablementId`, `watcher` and its schedule
(`scheduledFor`, `firedAt`); session actions record the same actor.

**Columns for what the database must enforce or query.** Item payloads
stay the typed projection of the protocol item: no SQL filters items by
deliverer or causation, and the event trigger reads causation from the
payload. A mailbox row is a queue between hosts, so what its destination
acts on is a column: `kind` (`input` or `action`, with the matching payload
required by a constraint), `attention`, `delivered_by`, `owner_authored`
(the sending host's finding that the owner wrote it, which decides whether
the owner's machine runs a turn) and `causation`.

Considered: one typed `metadata` object keeping the bag's shape, which
leaves kind-specific fields on every kind; columns for every delivery
field on items, which duplicates the payload for no query.

## Consequences

Item, mailbox and HTTP shapes change; migration 062 converts items and
pending mailbox rows and drops the mailbox `metadata` column. Readers lose
their hand validation. A new delivery fact is a typed field, a column only
when SQL must act on it.
