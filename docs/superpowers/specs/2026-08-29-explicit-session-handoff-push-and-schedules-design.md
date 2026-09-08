# Explicit session handoff, push, and schedules

## Goal

Let a person deliberately move an agent session from the desktop to a linked
server, resume a paused desktop-owned session from the PWA, receive useful
system notifications while the PWA is closed, and author schedules through
the same workflow trigger model as every other event source.

## Product language

The UI says that a session is **paused** when its authoritative host has not
renewed its lease and a server has a resumable transcript. The action is
**Resume on this server**. `recovery` remains an internal engineering term at
most and never appears in the PWA.

The PWA has one sessions list. Resumable sessions have a visible pause marker
and label in that list. There is no notification center or second session
collection.

## Invariants

1. Session movement is always an explicit user action.
2. A linked server never runs a mirrored session until it owns the session's
   monotonic authority revision.
3. Transcript synchronization is durable. A local transaction records sync
   intent before background delivery, and an intent remains pending until the
   destination acknowledges the exact authority revision and transcript
   watermark.
4. A coordinated desktop handoff blocks new local turns before the remote
   authority claim. A crash at any later point is reconciled idempotently.
5. A PWA may offer resume only when the source-host lease expired and the
   remote transcript is complete through its advertised watermark. Expiry is
   a presentation condition, never an automatic authority transfer.
6. Incognito sessions never enter replication, presence, handoff, or push
   state.
7. Web Push is an attention transport. Durable session and notification state
   stays on the server, and push delivery never becomes the source of truth.
8. Push payloads contain only the text and route needed to display and open
   the notification. They carry no transcript content, credentials, or bearer
   tokens.
9. The PWA service worker displays notifications and handles notification
   clicks. App state, fetching, resumability, and navigation remain in the app
   and API, preserving the native-wrapper seam.
10. Schedules are ordinary `trigger("schedule", config)` bindings in workflow
    TypeScript. There is no schedule workflow kind, database-authored workflow
    logic, or implicit local-to-remote fallback.

## Session replication and authority

The source host stores one coalescing replication intent for each
`(session, destination)`. Enqueueing a newer transcript updates the desired
authority revision and message watermark without losing the retry history.
Workers lease due intents, resolve credentials through the host, send the
full idempotent transcript, and acknowledge only a matching destination
receipt. Failures record the error and retry time. Startup, resume, network
reconnection, a short periodic tick, and a settled turn all request a drain.

The mirrored session records when the source authority was last observed and
the imported transcript watermark. A source heartbeat is an idempotent mirror
of the current stable snapshot, not a separate presence channel.

A desktop handoff has four durable states:

```text
local authority
  -> handoff pending (local sends blocked)
  -> transcript acknowledged remotely
  -> remote authority claimed with expected revision
  -> local copy records remote authority
```

The remote claim increments the authority revision with a compare-and-swap.
Repeating the same request returns the already-claimed session. If the desktop
dies after the remote claim, its pending handoff reconciles by reading the
remote session and recording the newer authority. If it wakes after a PWA
resume, its next mirror receives the newer authority and locks the stale copy.

## Desktop UX

The top-right chat control bar always includes **Move to server** for a real
session. The button uses `aria-disabled`, not native `disabled`, so keyboard
users can focus it and hear the reason. The standard hint opens on hover and
focus.

The action is unavailable with one precise reason: no linked server,
incognito, closed session, active or queued turn, sync pending, server
unreachable, incompatible remote Environment, missing remote agent or
connection authorization, handoff already running, or authority already
moved. Progress uses the same icon location. Success leaves the local copy
read-only and identifies the server that owns it.

## PWA UX and Web Push

The existing sessions endpoint projects `resumable`, `pausedAt`, and the last
acknowledged synchronization time for remote-owned mirrored sessions. The
existing sessions list adds a pause glyph and **Paused, tap to resume**. Tapping
the row performs the authority claim, invalidates the list, and opens the chat.

A paused-session push says that one or more sessions paused and can be resumed.
Its click route opens the ordinary sessions list, where every resumable row is
marked. Agent completion notifications deep-link to the session. Agent
question notifications deep-link to the waiting question.

Push subscriptions belong to tenant and external user identity and are scoped
to one PWA origin/device. The host exposes its VAPID public key and injects a
sender. The stock server persists a generated VAPID key pair in its data
directory. Subscription removal and permanent push-service failures retire
the endpoint.

Notification events and per-subscription deliveries are durable. A leased
worker retries transient delivery failures. Collapse keys prevent duplicate
OS notifications for the same event, but opening or dismissing an OS
notification does not mutate session state.

Permission is requested only from a user gesture. Unsupported, insecure, or
unconfigured origins keep all chat behavior and simply omit push setup.

## Schedule trigger

The host registers one parameterized trigger kind:

```ts
trigger("schedule", {
  cron: "0 8 * * 1-5",
  timezone: "Asia/Amman",
})
```

Scanning validates the cron expression and IANA timezone, then materializes a
schedule row for the frozen trigger binding. A Postgres worker claims due
occurrences with `SKIP LOCKED`. A unique `(binding_id, scheduled_for)` receipt
enrolls each occurrence once, and dispatch calls the normal trigger service.
The workflow receives `scheduledFor`, `firedAt`, and `bindingId`.

The binding's ordinary authorization projection selects its immutable commit,
Environment, exact connections, and principal. A linked project's hosting
server owns its schedule; a desktop-only project runs its schedule on that
desktop. Neither host silently falls back to the other when its owner is
unavailable.

Initial policy is intentionally small: missed occurrences coalesce into one
run on restart. Later overlap and catch-up policies can extend schedule config
without changing the workflow or trigger architecture.

## Verification

Tests cover coalescing intents, leases, retries, restart reconciliation,
duplicate and out-of-order mirrors, authority CAS races, incognito exclusion,
remote admission errors, PWA list markers and resume, push permission feature
detection, push display and click routing, retired subscriptions, schedule
timezone and cron validation, missed occurrences, duplicate claims, and normal
trigger dispatch. Desktop and PWA end-to-end tests cover the user-visible
paths, followed by the repository merge gate.
