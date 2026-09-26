# 0150: Site settings

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

**Screen sharing has its own picker.** A page's `getDisplayMedia` reaches
Chromium's permission handler first (a `media` request with no media types)
and the session's display-media handler second. The picker runs at the
first stage: "Choose what to share", Chrome's three panes (a browser tab
of this window, an application window, an entire screen), one Share
button. Audio is not asked: at that stage Chromium has not said whether
the page wants audio, so a shared tab carries its audio exactly when the
page asked for it (Chrome's default state). Cancel denies the permission, so the page sees
`NotAllowedError` exactly as in Chrome; a pick is stashed for the second
stage, which hands it over. Tabs are shared by their main frame (audio
too when requested, with local echo kept on), windows and screens by
capturer id. Tabs
list instantly; windows and screens arrive in a second pass because macOS
can take seconds to answer. When the capturer lists no screens (stale or
missing Screen Recording access on macOS), the displays are listed by id
so sharing can still be attempted, and a denied app gets a note with a
System Settings link. The "Screen sharing" site permission is therefore
Allow (the picker is the prompt) or Block; it never asks on its own.

**Electron 44.** Gmail flagged the browser as unsupported: Electron 43
carries Chromium 150 and Google keeps only the two newest Chrome majors.
Electron 44 (Chromium 152) fixes that, at the cost of macOS 13 as the
minimum and the async clipboard API. The user agent also carried a
dangling prerelease tail (`-alpha.8`) because only the numeric part of the
app's version token was stripped; whole tokens are stripped now, and the
app name token is matched without spaces, as Chromium writes it.

## Consequences

- Sites that used to get notifications silently now ask once, as in Chrome.
- (2026-09-26) A request to open another app names it ("wants to open
  Slack", from the scheme's registered app) and is withdrawn when its tab
  navigates, so a late answer never launches an app for a page that moved
  on. A prompt for a window in the background reveals its tab and asks for
  attention (a critical Dock bounce, a flashing frame elsewhere) until it
  settles. The app's own windows use the default session, which refuses to
  open other apps.
- The dialog owns the whole surface: a request never shows a bare prompt.
- No per-site storage size (Electron has no per-origin quota API); HTTP
  cache is not cleared per site.
- Device permissions (USB, HID, serial) and pop-up blocking stay as they
  were; they can join the same vocabulary later.
- System audio with a screen or window share is Windows-only in Electron;
  the picker offers audio for tabs only.
- Keeping Google's supported-browser gate happy means staying within two
  Chromium majors of Chrome stable: track Electron releases.
- Electron 43.6 through 44.4.3 throw an uncaught `Invalid guestInstanceId`
  from a `<webview>`'s `disconnectedCallback` when a loaded guest is
  removed (electron/electron#53989; fix #54089 merged to 44-x-y). The
  removal still completes. Until a release carries the fix, the renderer
  swallows that one error and the e2e harness ignores it (TODO.md).
