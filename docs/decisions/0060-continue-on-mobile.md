# 0060 — Continue on mobile: QR pairing makes the desktop a server

Status: Accepted (2026-08-21)

## Context

The PWA (ADR 0058) needs a server; the stock server (ADR 0059) is the
team answer. The personal answer should be the desktop itself — but its
embedded server binds loopback and treats every request as the desktop
user with root identity, so exposing it raw on a LAN would hand the
machine to the Wi-Fi. And a phone paired with the desktop must still
reach projects that live on a remote server without proxying through the
laptop.

## Decision

**A palette action ("Continue on mobile") shows one QR.** Scanning it
opens `http://<lan-ip>:<port>/?pair=<code>` — a LAN-facing listener the
desktop starts on demand (and at boot once any phone is paired), which:

- serves the built PWA at its root (workspace sibling in dev,
  `CATAMORPHIC_PWA_DIST` / packaged resources otherwise);
- exchanges the **single-use, 2-minute** pairing code for a device token
  at `POST /pair/claim`;
- proxies `/api/*` to the loopback embedded server **only with a valid
  device bearer** — the raw embedded server stays loopback-only and
  auth-free, exactly as before.

Device tokens are stored as **SHA-256 hashes** (`mobile-pairing.json`,
with the persisted port that keeps paired phones working across
restarts); the token itself exists only in the claim response. The QR
carries the machine's LAN IP and per-machine port — **no shared names,
no multicast — so any number of desktops on one Wi-Fi coexist** (the
stock server's mDNS default is likewise unique per install:
`catamorphic-<id>.local`).

**The claim hands over everything the phone needs**: the desktop
connection, the invoking profile's **remote-project links** (decrypted
from the profile store) so remotely-hosted projects keep talking to
their own server directly, and the **focused chat's context** — the
phone lands in the exact conversation that was on screen when the QR
was made.

QR-first, not QR-only: the modal keeps a copy-link button (no camera,
email-to-self, second machine).

## Consequences

- Scanning grants access **as the desktop user (root)** — the modal says
  so, codes are single-use and short-lived, and revocation is deleting
  the device entry from `mobile-pairing.json` (a management UI is
  follow-up work, alongside passkeys for the renew story).
- The LAN transport is plain http; fine for a trusted network, not for
  hostile ones — the remote story runs through the stock server.
- A DHCP address change orphans paired phones until they re-scan; the
  persisted port keeps the common restart case working.
- The pairing contract is pinned by `apps/desktop/e2e/mobile-pairing.e2e.ts`
  (claim once, 410 on reuse, bearer-gated proxy) and
  `apps/pwa/src/lib/pairing.test.ts` (connection + remote-link storage,
  chat deep-link).
