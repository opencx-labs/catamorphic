# 0077: Explicit session handoff, durable push, and schedule triggers

- **Status:** Accepted
- **Date:** 2026-08-29
- **Refines:** 0006, 0058, 0061, 0069, 0074, 0076

## Context

Session mirroring was a fire-and-forget push after a settled desktop turn. A
failed push had no durable retry until another turn, and continuing a mirror
created an implicit fork rather than an explicit transfer. The PWA had no way
to identify a safely resumable session or notify a person while closed.

Schedules were reserved for Postgres but not implemented. Watcher unification
in 0076 established that temporary automation must use ordinary workflow
trigger declarations, which schedules should follow as well.

## Decision

Session replication uses a Postgres outbox with leases, coalescing intents,
idempotent destination receipts, retry state, and transcript watermarks.
Session authority moves only through an explicit compare-and-swap action. The
desktop first persists a pending handoff that blocks local sends. The PWA may
offer **Resume on this server** after the source lease expires and the remote
holds an acknowledged snapshot, but expiry never moves authority by itself.

The desktop always shows **Move to server** in the chat controls. An
unavailable action remains focusable through `aria-disabled` and explains one
specific reason on hover and focus.

Web Push becomes an optional host-injected notification transport. Durable
notification events and deliveries live in Postgres. The PWA has no
notification center: push clicks navigate to the ordinary sessions list or a
specific session, and resumable sessions are marked in that one list. The
stock server owns a persisted VAPID key pair. Other hosts inject their own
sender and keys.

`schedule` is an ordinary registered trigger kind whose validated code-authored
config is materialized into Postgres. A leased scheduler claims due
occurrences and dispatches through `TriggersService`. Schedule placement is
the project's hosting server for linked projects, and the desktop for
desktop-only projects, using the binding's Environment, identity, and
connection snapshot. There is no automatic cross-host fallback.

We rejected a desktop-only retry file because it would not be embeddable, a
PWA notification inbox because it would duplicate the sessions model, and
automatic authority failover because a network partition could execute both
copies.

## Consequences

- Closing a laptop cannot lose an already-recorded replication intent.
- Moving or resuming remains understandable and deliberate.
- Push delivery may be delayed by an operating system, but the durable server
  state and actionable sessions list remain correct.
- Embedders can omit Web Push without losing session behavior.
- Schedules, watchers, webhooks, chat events, and tools keep one code-first
  trigger model.
- Linking a project gives its hosting server schedule ownership; the desktop
  stops shadow-running those bindings. Neither host silently falls back to the
  other when its owner is unavailable.
