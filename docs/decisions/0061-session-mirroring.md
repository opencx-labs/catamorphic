# 0061 — Session mirroring: local-first chats, continued on the server

Status: Accepted (2026-08-21)

## Context

Project FILES already converge desktop ↔ remote on every settled turn
(ADR 0044/0055). Conversations did not: a desktop chat lived only in the
desktop's database, so a phone connected to the remote server saw the
project's files but not its chats — and when the desktop slept, the
conversation was simply gone. The intended end state (per the product
owner): the desktop stays local-first, but everything it does flows to
the linked remote, and the remote is where continuation happens when the
desktop dies.

## Decision

**One-way live mirror, fork-on-continuation.**

- New route `PUT /projects/:id/agent/sessions/:sessionId/mirror`
  (`AgentSessionsService.mirror`): upsert the session under the CALLER's
  identity with the receiving registry's default agent, append the
  messages this side doesn't have (idempotent by message id; `seq` is an
  identity column, so payload order is transcript order). The provider
  anchor stays null — which means the existing re-anchor machinery seeds
  `transcriptHistory` on the next turn. **Continuation on the server is
  therefore free**: send a message to a mirrored session and the remote's
  assistant picks up with the full (capped) history.
- The desktop pushes after every settled turn (`RemoteSessionMirror`,
  hooked beside the ADR 0044 sync in `onAgentTurnSettled`), full
  transcript each time — idempotence makes offline gaps self-healing.
- **Divergence = handoff.** If the remote holds messages the push lacks
  (someone continued there), the mirror returns `409 {diverged: true}`
  and the desktop permanently stops pushing that session: the server
  owns the fork. No merge, no two-writer conflict — the same philosophy
  as git branches, applied to conversations.

**The QR completes the story** (ADR 0060 extension): when the focused
project is remote-linked, the pairing modal defaults to a QR of the
**remote server's PWA origin** — `https://server/?server=…&token=…&project=…&session=…`
(the member's existing token; no pairing code) — with "This Wi-Fi" as
the toggle. The `session` param deep-links the phone into the mirrored
copy of the exact chat that was on the desktop screen. Works from
anywhere, survives the desktop dying, and is the origin worth
installing from.

## Consequences

- Transcripts now leave the machine: mirroring runs for every
  remote-linked project, so linking a project to a server means your
  chats on it live there too (visible to that server's admin). A
  per-link opt-out is a straightforward follow-up if wanted.
- Mirrored sessions run the REMOTE's assistant on continuation — model,
  tools, and credentials are the server's, not the desktop agent's.
- Divergence is permanent for the desktop (per-process memory; a restart
  re-learns it from the same 409). Importing the server-side continuation
  back to the desktop is future work, not promised.
- Coverage: the stock-server test drives mirror → member visibility →
  server-side continuation (history-seeded) → divergence;
  `remote-mirror.test.ts` pins the pusher (payload, no-link no-op,
  stop-on-divergence); the PWA parses `session` deep-links.
