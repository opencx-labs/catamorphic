# 0220 — Sign-in popups answer passkeys in a sheet of their own

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** 0201 (Work keeps passkeys in the profile's vault), 0185

## Context

ADR 0201 answers passkey requests from browser tabs: the tab's preload
hands each request to main, and the workspace window shows the passkey
sheet over the tab. Sign-in popups were left out. A popup that a page opens
with `window.open` and window features (Google's sign-in from "Continue
with Google", most OAuth providers) stays a real child window so it keeps
`window.opener` (browser-popups.ts). It ran only the browsing session's
preload, never the tab's, and main accepted passkey requests only from tab
guests. So a passkey request in a popup reached Chromium alone, which in
Electron shows nothing and waits for a USB security key: Google's "Use your
passkey to confirm it's really you" did nothing on Continue, the 0185 hang
in the one place people meet passkeys most. The workspace's sheet could not
simply take the request either: a child window sits above its parent on
macOS, so the sheet would open behind the popup.

## Decision

**The browsing session's preload carries the passkey bridge.** It already
runs in every frame of a profile's browsing session, tabs and their popups
alike. It now wraps the Web Authentication API in each web page's top
frame (`preload/passkeys.ts`); the tab preload no longer does, so a tab is
wrapped once. Extension pages are not wrapped.

**Main answers a tab's popups as it answers the tab.** A request from a
window whose opener is a tab guest is accepted with the same origin, focus
and relying party checks, against the tab's profile and vault. Autofill
requests from a popup wait quietly, since a popup has no field suggestions
to offer them in.

**The popup shows its own sheet.** Main lays a transparent view over the
popup's page that loads the sheet alone (`passkey-sheet.html`, the same
`PasskeyHost`), so the sheet dims and sits over the page that asked, as it
does over a tab. The view is made on the popup's first request, kept while
the popup lives, and over the page only while a request waits; the page
takes focus back after. A sheet that starts listening after its request was
sent asks main for the requests it shows.

Alternatives: giving popups the whole tab preload, whose other jobs talk
to a host renderer a popup does not have; showing the workspace's sheet and
moving the popup behind it, which puts the sheet over the wrong page and
hides the one the person was using; and a native dialog, which the sheet's
input protection, layout and tests could not share.

## Consequences

- A saved passkey signs in from a sign-in popup, and a request Work cannot
  answer says why (iCloud Keychain and phone passkeys still need Apple's
  browser entitlement) and cancels into `NotAllowedError`, so the site
  offers its other ways in.
- Popups still have no password autofill or offer-to-save; those remain
  the tab preload's.
- The sheet view runs Work's own renderer with the desktop preload, as the
  workspace window does; it never navigates or opens windows.
