# 0149: Site settings

- **Status:** Accepted
- **Date:** 2026-09-22
- **Builds on:** 0062 (session privacy), 0147 (uniform sidebar sections)

## Context

Browser tabs answered every page permission request in the main process
with a fixed list: fullscreen, notifications and clipboard writes were
allowed, everything else denied, and nothing prompted. A site's voice chat
asked for the microphone and failed with no way to say yes. There was also
no place to see what a site had been given or stored, and no way to clear
its cookies short of deleting the profile.

Chrome's model is the one people already know: a per-site bubble with
Ask / Allow / Block for each capability, a prompt when a page asks, and a
"site settings" page that lists sites with their data and choices.

## Decision

**One modal for a site.** `SiteSettingsHost` (renderer, one per window)
shows everything about a site: its permissions, its stored data, and a
pending request from one of its pages. It opens four ways and is the same
component each time: the gear beside the bookmark star in the browser
toolbar, the palette's "Site settings" command (listed while a browser tab
is focused), a row on the Sites page, and a page's own permission request.
With a request pending, the question leads and the permission and data
sections start folded; opened by hand they are laid out in full. It is
centered, like every other modal in the app, not anchored to the address
bar as Chrome's bubble is.

**A site is an origin**, and a permission is one of `ask`, `allow`, `block`.
The vocabulary (`src/shared/site-settings.ts`) maps Chrome's kinds onto
Electron's permission names: location, camera, microphone, notifications,
clipboard reads, screen sharing, fullscreen, pointer lock, MIDI, and
opening other apps. Fullscreen and pointer lock default to allow; the rest
ask. Clipboard writes and DRM playback are always granted and have no
switch. Only explicit choices are stored (`profiles/<id>/site-settings.json`),
so the file lists exactly what the user decided; a choice equal to the
default is removed rather than stored.

**Requests resolve in the main process** (`browser.ts`): the session's
permission request handler consults the store; block if any kind the
request needs is blocked, allow if all are allowed, otherwise ask. A
`SitePermissionBroker` holds the pending request until the window answers
(`Allow` and `Block` are remembered; `Allow this time` and dismissing are
not) or the guest goes away. The synchronous check handler only denies what
is explicitly blocked, so `ask` reads as not-denied and the request handler
gets to prompt. On macOS, camera and microphone are additionally gated by
the OS per app; a site's Allow asks the OS once, and a denied app fails the
request cleanly and shows a note with a link to System Settings.

**Site data** is what Electron can clear per origin: cookies (including
parent-domain cookies the site can read), local storage, IndexedDB,
service workers and caches. The modal shows the cookie count and deletes
behind a confirm. The **Sites page** (`kind: "sites"` tab) lists every site
with a choice, a visit in history, or cookies, customized sites first.

## Consequences

- Sites that used to get notifications silently now ask once, as in Chrome.
- The dialog owns the whole surface: a request never shows a bare prompt.
- No per-site storage size (Electron has no per-origin quota API); HTTP
  cache is not cleared per site.
- Device permissions (USB, HID, serial) and pop-up blocking stay as they
  were; they can join the same vocabulary later.
