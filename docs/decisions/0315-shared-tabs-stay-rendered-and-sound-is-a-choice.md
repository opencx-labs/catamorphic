# 0315 — Shared tabs stay rendered, and sound is a choice

- **Status:** Accepted (amends 0150)
- **Date:** 2026-11-14

## Context

ADR 0150's picker only worked for the tab on screen. A background tab is
a `display: none` webview: its guest has no layout, Chromium's tab
capture never receives a first frame, and the page's `getDisplayMedia`
failed after ten seconds with `AbortError: Timeout starting video
source`. The picker also listed only tabs with a live page, and since ADR
0194 most tabs are asleep after a launch, so they were missing. A tab
shared while on screen froze as soon as the person switched to the call's
tab. Audio was not a choice because, under Electron 44, the permission
stage did not say whether the page wanted sound. Electron 45's
`display-capture` request names the requested media types. The window and
screen lists came from one capturer call with no time limit, and macOS
reports "denied" for Screen Recording also when it has never asked.

Sharing Work's other surfaces (a chat, a terminal, a note) was
considered. They are not separate pages, so Electron cannot capture them
by frame. Capturing the whole window and cropping to the surface would
run the crop in the receiving page, which can undo it and see everything
else. A separate copy of the surface would not share its state. Only web
pages are shareable.

## Decision

**The window lists its own tabs.** The picker builds the tab list from
the asking page's project in the window: every page of its profile and
browsing session (incognito with incognito only), awake or asleep, in tab
order. A window holding several projects answers a request once, in the
asking page's project. Pages on screen (or held) get a thumbnail; a hidden
page shows its icon, since capturing one can wait forever on macOS. Main
checks a pick: same window, same session.

**A shared tab stays rendered, as Chrome keeps painting a captured tab.**
Picking a tab holds it the way a tab an agent works is held: laid out,
transparent and inert while out of sight, told it is visible, and never
put to sleep. A sleeping tab wakes first. The picker answers once the page
is up and laid out; until then Share shows its pending state. Main polls
the shared page's capture each second and tells the window when the share
starts (the tab's icon gets an accent ring and its hover card names the
site) and when it ends, which releases the hold. Each pick holds the tab
on its own and is settled by its own request, so a pick given up never
releases a later one. A pick whose capture never starts is released after
15 seconds. While the share runs, the
window keeps drawing when covered or minimized, using the same rendering
hold as agent screenshots.

**Sound is a checkbox, shown when the page asks for it.** "Also share
tab audio" is on by default, as in Chrome. The tab keeps playing locally.
"Also share system audio" goes with an entire screen where Electron can
loop it back: Windows, and macOS 14.2 or later with
`NSAudioCaptureUsageDescription` in the bundle. It is off by default,
because it carries everything the computer plays. A window has no sound to
share, and the picker says so.

**Windows and screens are listed separately, each within eight seconds.**
Screens come back quickly and fill their pane first. A list that times
out says so with a retry, and screens fall back to the displays Work
knows. On Linux under Wayland, capture goes through the desktop portal,
whose own picker waits on the person: windows and screens are asked for
once, together, with no time limit. When Screen Recording is not granted,
the window and screen panes say Work needs it, link to System Settings,
list again when Work regains focus, and say to reopen Work if access was
just given. Work's helper surfaces (the detached dock, the voice bubble,
the passkey sheet) are not listed as windows; pages Work opened in windows
of their own (a site's popup, an extension's window) are.

**The picker holds still.** The list area has a fixed height, so loading,
switching kinds and arriving thumbnails do not resize the dialog.
Skeletons stand in for windows and screens. Each kind keeps its own pick,
and a single screen is picked already. Arrow keys move the pick and Enter
shares. Errors use a reserved status line. An answered request stays drawn
while the dialog fades out.

## Consequences

- Any of the window's pages can be shared, including after a relaunch,
  and the share keeps moving while the person works in another tab.
- A shared tab costs what an open page costs until the share ends, even
  if it would otherwise sleep.
- Tabs of other Work windows, and of the window's other projects, are not
  listed; such a window can still be shared as a window.
- System audio on macOS also needs the System Audio Recording permission,
  which macOS asks for on first use. If it is refused, Chromium ends the
  audio track without telling the page.
- Capture state is polled, because Electron reports no capture start or
  end. If Electron adds events, the poll can go.
