# 0080 — Installed pairing uses a one-time start URL bootstrap

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

Desktop QR pairing stores its device credential in the browser's local
storage. A home-screen web app may launch in a storage container that does not
contain that browser state. The static manifest then opens `/`, which makes a
successfully paired person look unconnected and sends them back to invite
onboarding.

Putting the long-lived device bearer token in the manifest or start URL would
make it durable in install metadata and URL surfaces. Assuming storage transfer
would keep the failure nondeterministic across mobile browsers.

## Decision

Each successful desktop pairing claim also mints a hashed, single-use install
bootstrap with a ten-minute lifetime. While the pairing page is open, the PWA
points its manifest at a start URL carrying that bootstrap. If the installed
app starts without local state, it exchanges the bootstrap for an additional
credential on the same paired-device record, restores the normal local PWA
store, and lands in the paired chat context.

For a remote-server QR, no desktop credential is involved. The manifest
instead preserves the credential-free server, project, and session locator in
its start URL. The PWA retains that locator across the OAuth page reload and
reapplies it to the manifest. A storage-isolated installed app restarts OAuth
automatically and returns to that chat rather than falling back to the
invitation form. Later launches reuse the stored connection and route directly
to that project or chat without repeating OAuth.

The install bootstrap is not an API bearer token. It is consumed once, is
stored only as a hash by the desktop, and rotates when redeemed. Revoking the
paired device revokes both the browser and installed-app credentials.

## Consequences

Home-screen launch no longer depends on browser-to-app storage inheritance and
does not return a paired user to invite onboarding. The desktop listener owns
one small dynamic manifest route and a pairing recovery endpoint. Installation
must happen while the short-lived bootstrap is valid; otherwise the user scans
a fresh QR.
