# 0185 — Passkey requests in browser tabs stay answerable

- **Status:** Accepted
- **Date:** 2026-09-28
- **Refines:** 0137 (sign-in recovery)

## Context

Electron services Web Authentication with no UI and no timer of its own.
Without a platform authenticator configured, only a USB security key can
answer, so a site's passkey button left the page spinning forever: the
relying party's `timeout` was ignored, and every later request on the page
failed at once as already pending. Autofill requests (conditional
mediation), which many sign-in pages start on load, held the same single
slot, and `getClientCapabilities()` advertised passkeys from a phone and a
platform passkey provider that Electron cannot deliver. A person who tried a
passkey saw the app hang.

## Decision

**The guest preload wraps the API in the page's world**, as it does
notifications. Each modal `get`/`create` keeps Chrome's deadline (five
minutes when absent, held between ten seconds and ten minutes), can be
cancelled from the window, and rejects with Chrome's `NotAllowedError` when
cancelled or expired; the page's own abort keeps its reason. Autofill
requests wait in the wrapper, off Chromium's slot, until the page aborts
them; a quiet `create` after a password sign-in is refused. Capabilities
read honestly: conditional mediation, phone (hybrid) and platform passkey
providers are unavailable, so sites offer their other ways in.

**The window shows each modal request** in a passkey sheet
(`PasskeyHost`, same modal family as site settings): the site, what can
answer here (a security key), what cannot yet (passkeys on a phone, in
iCloud Keychain or a password manager), and Cancel. When a Work sign-in
attempt is active, the sheet offers ADR 0137's "Continue in your browser".
The sheet closes when the request settles, and a navigation or closed tab
withdraws it.

Alternatives: a main-process timer is not possible (Electron exposes no
WebAuthn request events); declaring passkeys unsupported entirely would
also break security keys, which work.

## Consequences

- A passkey attempt always ends: the person cancels, the site's deadline
  passes, or a security key answers.
- Only the top frame is wrapped; a passkey request from a cross-origin
  iframe still waits unanswered.
- Security keys that need a PIN fail cleanly (Electron has no PIN entry,
  electron/electron#24573).
- Real passkeys are follow-up work. Electron 44's `app.configureWebAuthn`
  adds a device-bound Touch ID authenticator, but it needs the
  `keychain-access-groups` entitlement, which the signed app can claim only
  with a Developer ID provisioning profile that the release does not embed
  yet. Synced iCloud Keychain passkeys need Apple's browser passkey
  entitlement and support Electron does not have.
