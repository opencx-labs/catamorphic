# Pwa (mobile PWA)

Phone-sized client for a Catamorphic server (ADR 0058): projects →
sessions → chat. Reply, nudge (queue / send-now + interrupt), answer
agent questions and tool-permission asks, start simple chats. The session list
shows promoted sessions only; latent delegated children remain with their
parent and archived trees stay out of ordinary mobile navigation. Remote auth uses
OAuth authorization code with S256 PKCE (ADR 0072); profiles are local people
on this device, each holding refreshable server connections. Read `docs/decisions/0058-mobile-pwa.md`
before changing architecture.

## Run

- `bun run dev:pwa` (repo root) — Vite dev server with workspace
  watchers; `--host` is on, so open it from a phone on the LAN.
- Backend for development: use the fake with
  `node scripts/dev-server.mjs`; it prints a credential-free connect link and
  serves the same OAuth discovery, authorization, refresh, and bearer shape as
  a remote host. Use desktop QR pairing to exercise the desktop connection.
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
- The service worker (`public/sw.js`) serves the offline shell, displays Web
  Push, and opens notification routes. App logic (queues, reconnection,
  polling, resumable state) lives in app code. A Capacitor wrap must be able
  to replace the SW transport without losing behavior.
- Web Push is the installed PWA transport (ADR 0077). Events and subscriptions
  stay behind the server API so a native wrap can substitute APNs/FCM. Do not
  add an in-app notification center.
- Keep every fetch behind `lib/api.ts` (bearer wrapper) and storage
  behind `lib/store.ts` (a wrap swaps in secure storage there).
- Composer inputs stay ≥16px font-size (iOS zoom) and the page never
  scrolls — screens own their scrolling (`overscroll-contain`).

## Pairing (Continue on mobile)

A desktop QR opens this app at `/?pair=<code>` on the desktop's LAN
listener (ADR 0060): `lib/pairing.ts` claims the code, stores the
desktop connection plus the profile's remote-project links, and
deep-links into the chat the desktop had focused. The desktop serves
the BUILT bundle, not this app's dev server. `bun run dev:desktop`
keeps that bundle current for you (a watch build runs alongside the
desktop); anywhere else, run `bun run build` here after UI changes or
the QR flow ships a stale app.

Pairing also prepares a ten-minute, single-use install bootstrap in the web
app manifest (ADR 0080). An installed app may have a separate storage container
from the browser that scanned the QR; `/?install=...` redeems a second
credential on the same paired-device record and restores the pairing and chat
context without exposing the long-lived bearer token in install metadata.
Remote-server installs preserve only the credential-free project and session
locator in the manifest and restart OAuth on first launch, then return to the
same chat.

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
