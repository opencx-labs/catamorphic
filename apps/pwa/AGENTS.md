# Pwa (mobile PWA)

Phone-sized client for a Catamorphic server (ADR 0058): projects →
sessions → chat. Reply, nudge (queue / send-now + interrupt), answer
agent questions and tool-permission asks, start simple chats. Auth is a
connect link (ADR 0055); profiles are local people on this device, each
holding their redeemed links. Read `docs/decisions/0058-pwa-pwa.md`
before changing architecture.

## Run

- `bun run dev:pwa` (repo root) — Vite dev server with workspace
  watchers; `--host` is on, so open it from a phone on the LAN.
- Backend for development: either the desktop app's embedded server
  (paste a `catamorphic://connect?server=http://127.0.0.1:<port>/api&token=x&project=<id>`
  link; any token works against the desktop's identity), or the fake:
  `node scripts/dev-server.mjs` — it prints a redeemable connect link.
  The fake's scripted agent: `ask …` parks a tool-permission ask,
  `question …` asks a question, `fail …` fails the turn.

## Verify

- `bun run typecheck && bun run test` (unit: parsers, theme, nav)
- `bun run test:e2e` — builds, then drives headless Chrome (CDP) against
  the fake server: connect → chat → permission → question → back-stack.
  Needs a local Chrome; suite skips without one.
- `bun scripts/shots.ts <dir>` — screenshot tour for design review.
- Repo root: `bun run lint` (Biome) before calling anything done.

## Rules

- Same design tokens as the desktop (`src/styles.css` mirrors
  `apps/desktop/src/renderer/styles.css`; `lib/theme.ts` mirrors the
  desktop's `theme.ts` presets — change them together).
- `components/catamorphic/*` are copies of `packages/registry` sources
  (the intended shadcn-style reuse); diff against the registry when
  updating.
- The service worker (`public/sw.js`) serves the offline shell ONLY.
  App logic (queues, reconnection, polling) lives in app code — a
  Capacitor wrap must be able to drop the SW without losing behavior.
- No Web Push here: notifications are the future native wrap's job
  (APNs/FCM); don't engineer around iOS Web Push.
- Keep every fetch behind `lib/api.ts` (bearer wrapper) and storage
  behind `lib/store.ts` (a wrap swaps in secure storage there).
- Composer inputs stay ≥16px font-size (iOS zoom) and the page never
  scrolls — screens own their scrolling (`overscroll-contain`).

## Pairing (Continue on mobile)

A desktop QR opens this app at `/?pair=<code>` on the desktop's LAN
listener (ADR 0060): `lib/pairing.ts` claims the code, stores the
desktop connection plus the profile's remote-project links, and
deep-links into the chat the desktop had focused. The desktop serves
the BUILT bundle — after UI changes run `bun run build` here or the QR
flow ships a stale app.

Failover semantics (troubleshooting "the desktop is asleep"): the claim
also carries a mirror map (desktop projectId → its remote server), kept
on the desktop connection (`mirrors`). Desktop and remote are SEPARATE
backends — no auto-switch; when a desktop-connection request fails,
`components/connection-trouble.tsx` explains why and offers the
project's remote mirror as the way in. Since ADR 0061 the desktop
mirrors its transcripts to the linked remote after every settled turn,
so the remote's copy of a chat is the SAME session id, continuable
there (`?session=` deep-links from the remote-origin QR land in it);
continuing on the server forks it — the desktop stops pushing that
session.
