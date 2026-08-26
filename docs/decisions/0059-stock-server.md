# 0059 — The stock server: zero-dependency, disk-backed, invite-first

Status: Accepted (2026-08-21; auth, invites, and administration superseded by 0071 and 0072)

## Context

ADR 0055 settled identity and TODO.md promised a "default self-hostable
Catamorphic server": the resolver plus a token-issuing auth adapter and a
config file. The mobile PWA (ADR 0058) made it urgent — a phone needs
a server to point at, both on the LAN (the personal case) and remotely
(the team case). Every ingredient existed as a library; no host did.

## Decision

**`apps/server`: `docker run`-able, zero external services.** One data
dir holds everything: PGlite (the desktop's own recipe — pgcrypto,
`search_path`, worker concurrency 1), bare git origins via
`FsRemoteBackend`, `FsBundleStore`, and `LocalProcessSandboxProvider`
(ADR 0047: the container IS the sandbox; bash+git+bun are the image's
runtime contract; **single-tenant only**). The HTTP surface is the stock
`createApp` (CORS, swagger, `/api`), so the PWA and the generated
client work unchanged.

**Auth is a file, invites are the flow.** `auth.json` holds bearer
tokens: one admin token (root identity) minted at first boot and printed
to the console, and per-invite member tokens. `POST /admin/invites`
does the whole ADR 0055 dance — deploys a committed `roles/member.json`
(agents: assistant, a private `store/users/{user}/**`) to origin `main`,
grants the membership, mints a token — and returns connect links for
every address the server answers on. Tokens carry no rights: every
request re-resolves through `memberships.identityFor`, so revoking a
membership or deleting the token file entry cuts access on the next
request.

**One agent, addressable two ways.** The env-configured "assistant"
(Anthropic/OpenRouter/OpenAI via the AI SDK; `CATAMORPHIC_FAKE_AGENT=1`
for a deterministic echo) is served by the registry as both bare
`assistant` and `project:<id>:assistant` — the latter is what a scoped
member's role ref resolves to, without requiring committed
`agents/*.json` files. Tool-permission asks park on a
`ToolPermissionBroker`, so phones answer them over HTTP (ADR 0058's
mechanism, here as the only surface).

**The server serves the PWA at its root** (workspace `apps/pwa/dist`,
`CATAMORPHIC_PWA_DIST` in Docker; a landing page without it) — this is
the phone's off-network home: invites return `webLinks`
(`https://server/?server=…&token=…`) that open the hosted app directly,
and behind TLS the service worker and install prompt work, which the
desktop's plain-http LAN origin cannot offer.

**LAN discovery is a hostname, not a protocol.** A hand-rolled ~150-line
mDNS responder answers A queries for `catamorphic.local`, because
browsers cannot do mDNS but every phone OS resolves `.local` names —
invite links minted against `http://catamorphic.local:4700/api` survive
DHCP. `CATAMORPHIC_MDNS=off` (or a different name) opts out; remote
deployments set `CATAMORPHIC_PUBLIC_URL` instead.

Two core fixes surfaced by building the first real second host:
`deployment.deploy` now drops the program-fetch memo after pushing (a
pre-deploy read could otherwise serve the pre-push tree to the very next
role resolution), and the dev-sandbox git commands pass `cwd` via
`ExecOpts` instead of embedding `cd /workspace/...` in the command
string — virtual sandbox paths are only real on providers with a mounted
root, which local-process is not.

## Consequences

- The PWA's scoped path is now exercised for real: it reads `/me`
  and addresses `project:<id>:<agent>` when the identity isn't root
  (`e2e/stock-server.e2e.ts` boots this server and drives the phone UI
  through invite → chat).
- No signup/SSO/renew flow yet: identity is "whoever holds a minted
  token", which fits a personal or small-team server. The `renew=` slot
  in connect links stays empty until a real auth adapter exists.
- The admin surface is API-only (curl); an admin UI is follow-up work.
- PGlite serializes writes: this scales to a small team, not a fleet.
  The same app boots against real Postgres by swapping the database
  config if that day comes.
