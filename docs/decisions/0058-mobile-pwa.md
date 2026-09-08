# 0058 — The mobile PWA: chats on the go, wrapper-ready

Status: Accepted (2026-08-21)

## Context

The desktop's chat surface already speaks plain HTTP: the embedded Fastify
server serves the agent-session routes, `@catamorphic/api-client` is a
generated typed client, and `@catamorphic/react`'s `useAgentChat` owns the
queue/nudge/interrupt orchestration. Nothing about chatting with an agent
is Electron-specific — but the only client was the desktop renderer, and
tool-permission asks could only be answered by the desktop modal (the
desktop registered no `ToolPermissionBroker`, so `GET …/permissions`
returned 503).

We want a phone-sized PWA: see your projects, follow and reply to
agent sessions, nudge a working agent, answer its questions and
tool-permission asks, start simple chats. MVP now, a Capacitor wrap later
(push, lock-screen approvals, widgets) without rewriting.

## Decision

**A new app, `apps/pwa`** — Vite + React + Tailwind v4, installable
PWA (manifest + an offline-shell service worker that owns no app logic).
It consumes `@catamorphic/api-client` + `@catamorphic/react` directly and
copies the registry's `chat-timeline` / `tool-permission-card` (the
shadcn-style intended reuse path). Same design tokens as the desktop;
system-first font stack on phones.

**Auth is the connect link** (ADR 0055): `catamorphic://connect?...` — or
the same params on an https URL, which is what an invite web link looks
like when it opens the PWA. No invite/token machinery was added; the app
is a pure client of whatever host issued the link. Each link is one
project connection; a root token (the desktop's own embedded server, used
in development) yields the server's whole project list.

**Profiles are local**: a person on this device — name, color, and the
connections (redeemed invites) they hold, mirroring the desktop's
"a profile is a person; the token is theirs". Stored in localStorage
behind one module (`lib/store.ts`) so a wrap can swap in secure storage.

**Liveness is polling**, because that is what the platform does today
(`useAgentSession`'s 500ms working-poll, `useToolPermissions`' 1.5s ask
poll). No SSE was invented for this. Navigation is a tiny history-backed
hash router so the platform back gesture pops a real stack.

**Theme sync**: there is no per-project theme anywhere in the platform
(desktop themes are per-profile), so the PWA reads an optional
committed `.catamorphic/theme.json` — the same `{ preset, overrides }`
shape and resolution as the desktop's `theme.ts`, presets duplicated
knowingly — and falls back to Catamorphic Dark. No theme UI on mobile.

**Install promotion is capability-led and one-shot.** On a secure origin,
the app captures Chromium's `beforeinstallprompt` event and offers the native
install flow; iPhone and iPad get Safari's Share → Add to Home Screen
instructions because iOS exposes no programmable prompt. Installed mode hides
the promotion. Dismissing either form writes a permanent origin-local marker,
so Catamorphic never asks that browser profile again unless its site data is
cleared. The desktop's plain-HTTP LAN origin never offers installation; a
remote server behind HTTPS is the installable origin.

**The desktop now registers a `ToolPermissionBroker` and races it against
its consent modal.** `broker.open()` (new) exposes the pending id; the
registry's ask handler races modal vs. broker — first real answer wins,
the loser is withdrawn (the modal via an `AbortSignal` on the bridge and a
`toolPermissionCancel` RPC that silently removes the queued card; the
broker entry via `answer()`). `createCatamorphic` passes `toolPermissions`
through to core. Result: any HTTP client can now see and answer asks, and
answering on the phone dismisses the desktop modal — one ask, many
surfaces, one answer.

## Consequences

- The chat API contract is now consumed by a second, non-Electron client;
  route/schema changes must keep the PWA in mind.
- `apps/pwa/scripts/dev-server.mjs` is a scripted fake of the
  agent-session surface (turns, asks, questions) — the PWA's e2e
  backend and a reference for the routes' wire shapes.
- The Capacitor wrap stays cheap by construction: notification events and
  subscriptions are server-owned, while Web Push is only the installed PWA
  transport (superseded by ADR 0077). A native wrap can substitute APNs/FCM;
  auth remains origin-agnostic.
- Real remote servers still need a host that issues connect links
  (unchanged: an invite is `memberships.grant` plus whatever link the
  host sends).
