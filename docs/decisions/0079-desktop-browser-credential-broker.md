# 0079 — Desktop browser credential broker

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

The desktop browser already stored per-profile passwords in a KDBX4 vault, but
its webview preload sent captured and revealed plaintext through the React
renderer. Passwords also had no management surface, and the browser-import
implementation was hidden, supported Chromium bookmarks only, and had no
Firefox path. Stock Electron does not expose Chromium's private native password
manager APIs, so reproducing Codex's browser integration exactly would require
maintaining a Chromium fork.

## Decision

The desktop keeps the portable per-profile KDBX4 vault and makes the Electron
main process its credential broker. A webview sends submitted credentials
directly to main. Main validates the guest, owning window, profile, and exact
HTTP origin, retains the secret behind a short-lived opaque offer ID, and sends
the renderer metadata only. Autofill performs the same checks and sends the
decrypted credential directly from main to the target guest. Device
authentication continues to gate secret retrieval once per profile per app
run. The renderer may receive plaintext only for an explicit, authenticated
reveal in profile settings; copy is performed in main.

Profile settings is the management surface for listing, searching, adding,
editing, revealing, copying, and deleting saved passwords. It also exposes
browser import. Chrome-family JSON bookmark stores and Firefox Places databases
are read directly. Passwords use the browsers' portable CSV export format and
are normalized and written into the selected profile's vault. This avoids
depending on private Chrome key formats or Firefox NSS internals that change by
browser and platform.

## Consequences

Ordinary page capture and autofill no longer expose secrets to React or permit
cross-origin reuse. The broker's status-only renderer contract is also safe for
future agent-driven browser actions. Users gain one coherent profile-scoped
place to manage and import credentials. Importing passwords requires an export
file from Chrome or Firefox instead of silently reading their encrypted login
databases. The desktop owns this policy; it does not add identity or credential
storage to the embeddable Catamorphic framework.
