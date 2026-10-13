# 0226 — Pages ask through Work's dialogs

- **Status:** Accepted
- **Date:** 2026-10-13
- **Amends:** 0150 (site settings), 0151 (browser passwords), 0194 (tab sleep), 0202 (agent browser tools)

## Context

A page in a Work browser tab could not ask anything. Measured on Electron
45.0.0-beta.1: `alert` and `confirm` went to Electron's native message box,
tied to no tab; `prompt` threw; a held `beforeunload` silently stopped
reloads, addresses and links; every HTTP sign-in was cancelled.
Electron has no hook for page dialogs, and CDP only observes them beside
Electron's own dialog manager, which answers `prompt` at once.

## Decision

**Script dialogs go over a synchronous IPC.** The tab preload replaces
`alert`, `confirm` and `prompt` in the page's world with functions that
`sendSync` and return what main sets as `event.returnValue` once the person
or an agent answers. The page waits as in Chrome; main, other tabs and the
chat do not. The bridge reaches the page only as an argument of that code,
never as a global it could call. Tabs run their preload in every frame
(`nodeIntegrationInSubFrames`, tab webviews only), so embedded frames ask
too, named by their own origin; all other preload work stays in the top
frame.

**What never asks.** As in Chrome, a page being left: a `beforeunload`
handler (read from the page's current event, since a beforeunload listener
of the preload's own would make every navigation wait on the page), or
anything from `pagehide` on. Main also refuses a frame that is detached or
no longer in the tab's frame tree, so an old page unloading after its
successor committed cannot ask over it, and an embedded frame with an
opaque origin, since the preload cannot see whether a sandbox allows
modals.

**"Leave site?" asks after the fact and replays.** `will-prevent-unload`
must be answered synchronously, and blocking the page instead loses to
Chromium's 500 ms beforeunload timeout for anything the browser starts
(measured). So main keeps the page, asks, and on Leave redoes the latest
attempt: a reload, address, back or forward the tab announced, or the
page's own navigation announced by the Navigation API's `navigate` event,
which the preload replays.

**Closing asks only when it disposes of the page.** A person's tab close,
or their removal of a chat's page, asks; a chat page going back to its chip
(still loaded), or an agent's or extension's close, does not. The page's
beforeunload runs through `webContents.close({ waitForBeforeUnload: true })`.
Electron unloads a webview's page whatever it answers (its internal
`-before-unload-fired` handler honours the answer only for windows), so
main keeps the page loaded on that private event and the tab leaves with
its own exit. That close also grants the page a user activation
(measured), so its windows and permission requests are refused until it is
answered.

**Sign-ins ask in the tab,** naming the site or proxy and its realm. The
profile's saved sign-ins for that origin are offered; picking one reads the
password in main, never in the renderer, and a typed sign-in the top frame
lands gets the usual save offer. Requests for one sign-in (page, proxy,
site, realm) share one dialog and its answer, as in Chrome. Another site's
subresource never asks, and another site's embedded page says it is one.
Cancel leaves the 401 page.

**Tab-modal, one at a time.** Main keeps a queue per page; the tab shows
one dialog over its dimmed page, keeps it while out of sight, and cancels
it on navigation or close.

**Agents answer as a person would.** Snapshots report the dialog, `press`
and `fill` answer it, and an action that opens one returns rather than
hanging (apps/desktop/docs/computer-use.md). A sign-in is never the
agent's to answer. No tool schema changed.

Alternatives: CDP interception (Electron answers first); `disableDialogs`
(nobody is asked); blocking the page for beforeunload (the timeout wins);
window-modal dialogs (one page would hold all of Work).

## Consequences

- Without `-before-unload-fired` (a later Electron), a held tab close
  unloads the page as before; `e2e/page-dialogs.e2e.ts` fails then.
- The activation from a close also reaches APIs that need no permission
  (a file chooser).
- A sandboxed frame that keeps its origin can still ask without
  `allow-modals`; one with an opaque origin never asks, even with it.
- While "Leave site?" is open the page keeps running. A replayed form
  submission is sent again from the page; a navigation the Navigation API
  did not announce is allowed, not redone.
- Sign-in popups keep Electron's native alert and confirm; neither they nor
  extension views get a sign-in dialog.
