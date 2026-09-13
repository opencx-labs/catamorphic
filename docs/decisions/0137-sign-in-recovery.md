# ADR 0137: Sign-in recovery stays with the active attempt

- **Status:** Accepted
- **Date:** 2026-09-12
- **Refines:** 0088

## Context

Passkeys stored by another browser or password manager are not transferred by
our bookmark/password importer. The pinned Electron runtime does not expose
system passkeys for arbitrary sites. An indefinite waiting state leaves the
user unable to finish onboarding or grant repository access.

## Decision

Sign-in continues to open in the requesting profile's workspace browser.
A top-chrome status inspector explains the remaining time and offers cancellation.
Under sign-in help, users can explicitly continue in their usual browser as a
last resort. This is a narrow exception to ADR 0088's web-link rule, not a change
to ordinary link routing. Main retains the initiating authorization URL and the
same active callback; the renderer cannot supply arbitrary external URLs.

Browser import must describe its real capabilities. Offer it as a passkey
recovery path only when passkeys can actually transfer and work here. Today it
imports passwords and bookmarks and explicitly excludes passkeys.

Expired or cancelled attempts stop listening and close their temporary login
tab. Retrying creates a fresh attempt. A callback only completes the matching
request, and does not claim successful connection before token exchange.

## Consequences

Users can recover from unsupported passkeys without losing the pending sign-in.
Native system passkey integration and credential exchange remain separate work;
we must not imply browser import implements either capability.
