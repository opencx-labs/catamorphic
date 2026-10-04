# 0201 — Work keeps passkeys in the profile's vault

- **Status:** Accepted
- **Date:** 2026-10-04
- **Amends:** 0185 (passkey requests stay answerable), 0151 (browser password manager)

## Context

ADR 0185 made a passkey request end cleanly, but Work still had nowhere
to keep a passkey. Only a USB security key could answer, so a site's
passkey button led to a sheet saying passkeys "can't be used in Work
yet". 0185 named Electron 44's Touch ID authenticator
(`app.configureWebAuthn`) as the next step. That store is tied to one
Mac's Secure Enclave and sits beside the password vault rather than in
it. It needs a `keychain-access-groups` entitlement the release cannot
claim without a provisioning profile, and nothing can be imported into
it. Many people's passkeys live in a password manager. A passkey can
only move if its manager writes the private key into an export, which
Bitwarden (JSON) and KeePassXC (KDBX) do. Apple, Google and 1Password
keep their passkeys out of files.

## Decision

**Work is its own passkey provider, the way the 1Password and Bitwarden
browser extensions are in Chrome.** Passkeys are entries in the
profile's existing KDBX vault (ADR 0151). They use KeePassXC's
attributes (`KPEX_PASSKEY_*`, PKCS#8 PEM private keys), so a KeePassXC
database imports as it is. Main does all WebAuthn work in
`main/webauthn.ts`: key generation (ES256, Ed25519, RS256), CBOR/COSE,
authenticator data, "none" attestation under Work's own AAGUID, and
signatures. Private keys never reach a page or the renderer.

**The guest preload hands each request to main** instead of only adding a
timer. Main builds the client data from the requesting frame's own URL.
It checks the relying party id against that origin with the public
suffix list (`tldts`): no public suffixes, no IP addresses, and http
only on localhost. Related origins are not consulted. The page receives a
real `PublicKeyCredential` (platform prototypes, own values, `toJSON`).
Chromium runs the same request alongside, so a security key still
answers. The 0185 deadline, cancel and one-sheet rules stay.

**The sheet answers.** Signing in lists the profile's passkeys for the
relying party, narrowed by `allowCredentials`. Creating offers **Save
passkey** for the named account. An account with an excluded credential
gets "already saved", which ends as `InvalidStateError`. A
security-key-only request or an unsupported algorithm says why Work
cannot answer. Each use asks Touch ID, never cached, and sets the
user-verified flag. A Mac without Touch ID treats the click as user
presence: the response says unverified, and a site that requires
verification is told Touch ID is unavailable. Autofill (conditional
mediation) is now offered. Passkeys appear first in the suggestions
under a field marked `autocomplete="webauthn"`. Sites learn
`conditionalGet` and `passkeyPlatformAuthenticator`. Hybrid (phone)
transport stays unavailable.

**Flags and counters.** Passkeys Work creates are backup eligible (the
vault is a file that can be copied), not backed up (nothing syncs it),
and keep a zero counter like synced passkeys. An imported passkey that
counted keeps counting from its stored value.

**Import is one file action** on Settings and the Passwords page. It
takes a CSV (Chrome, Firefox, Safari, Bitwarden columns), a Bitwarden
JSON export, or a KeePass database. The file type comes from its
contents. A database asks for its password and optional key file in a
Work dialog, while main holds the file under a ten-minute token. Logins
and passkeys import once each: a login by site and username, a passkey
by relying party and credential id. The Passwords page lists passkeys
and deletes them; they never reveal or copy.

**Deletes are permanent.** The vault no longer moves entries into the KDBX
recycle bin, which listings walked, so deleted logins had come back.
Entries already there stay hidden.

Alternatives: Electron's Touch ID authenticator (above). Apple's
browser passkey entitlement, which would reach iCloud Keychain and other
system providers, is requested separately. It needs Apple's grant and
native AuthenticationServices code, and complements this store rather
than replacing it.

## Consequences

- A site's passkey works in Work: create, sign in, autofill. Bitwarden and
  KeePassXC passkeys move in.
- Passkeys live on one Mac in one profile, like passwords. They do not
  sync, and other apps cannot use them.
- iCloud Keychain and phone passkeys still cannot be used until Apple
  grants the browser entitlement. 1Password and Google passkeys cannot be
  imported until those managers export them (FIDO Credential Exchange).
- A vault that cannot open (a locked keychain) still shows the sheet,
  which says so, so the request stays answerable by a security key or
  a cancel.
- Only the top frame is wrapped, as in 0185. Cross-origin iframes and
  related-origin requests are not answered by Work.
- Encrypted Bitwarden exports are refused with instructions rather than
  decrypted.
