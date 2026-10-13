# 0226 — Pages ask through Work's dialogs

- **Status:** Accepted
- **Date:** 2026-10-13
- **Amends:** 0150 (site settings), 0151 (browser passwords), 0194 (tab sleep), 0202 (agent browser tools)

## Context

A page in a Work browser tab could not ask the person anything. Measured
against local pages on Electron 45.0.0-beta.1: `alert` and `confirm` went
to Electron's native message box (a GTK dialog in the Linux test display),
outside Work's look and not tied to the tab; `prompt` threw "prompt() is
not supported"; a `beforeunload` that holds the page emitted
`will-prevent-unload`, which nothing handled, so reloads, typed addresses,
links and Back silently did nothing (the address bar kept the address that
never loaded); and every HTTP sign-in was cancelled, showing the 401 page.

Electron has no hook for a page's JavaScript dialogs, and CDP's
`Page.javascriptDialogOpening` only observes them beside Electron's own
dialog manager, which answers `prompt` at once.

## Decision

**A page's own dialogs are answered over a synchronous IPC.** The tab
preload replaces `alert`, `confirm` and `prompt` in the page's main world
(`contextBridge.executeInMainWorld`, as `Notification` already was) with
functions that `ipcRenderer.sendSync` and return what main sets as
`event.returnValue`. Main sets it when the person or an agent answers, so
the page waits exactly as in Chrome while main, the window, the chat and
other tabs carry on. Tabs run their preload in every frame
(`nodeIntegrationInSubFrames`, turned on in `will-attach-webview` for the
tab preload only), so an embedded frame asks too and is named by its own
origin ("An embedded page at … says"); everything else in both preloads
stays the top frame's, as before. Dialogs from `beforeunload`, `pagehide`
and `unload` handlers are refused, as Chrome refuses them; the page's
current event tells, since a listener of the preload's own would give
every page a beforeunload handler and make each navigation wait on it.

**"Leave site?" keeps the page, then redoes what was leaving it.**
`will-prevent-unload` must be answered synchronously, and a sync wait in
the page loses to Chromium's 500 ms beforeunload timeout for anything the
browser starts (measured: a navigation started half a second into a
three-second handler). So main lets the page stay and asks. Leave allows
the next unload for five seconds and does again what was leaving: the tab
tells main before it reloads, goes to an address, back or forward; the
page's own navigation (a link, a form, a script) is the one the Navigation
API's `navigate` event announced just before, which the preload replays.
Closing a tab asks the page first (`webContents.close({ waitForBeforeUnload:
true })`) unless the person never touched it, and Leave closes it. Electron
lets a webview's page close even when its beforeunload holds it (its
internal `-before-unload-fired` handler honours the answer only for
windows), so main cancels a held close on that event; forced closes (an
agent's, an extension's) are final.

**Sign-ins ask in the tab.** `login` on a tab's page opens a sign-in dialog
naming the site (or the proxy) and its realm, with the profile's saved
sign-ins for that origin: picking one reads its password in main, never the
renderer. A typed sign-in that the site accepts (the page commits without
401) gets the password card's "Save password?". Cancel answers nothing, so
the 401 page shows; a refused sign-in asks again with the username kept.
Another site's subresource never asks. Sign-in popups and extension views
keep Electron's answer for now.

**Tab-modal, one at a time.** Main keeps a queue per page
(`main/page-dialogs.ts`) and tells the tab's window; the tab shows the
first over its page, dimmed, centered like every Work dialog but inside
the page's area. A tab out of sight keeps its dialog and shows the waiting
"?" badge; brought forward, the dialog takes focus. Navigation or closing
the tab cancels what the page asked. From a page load's second script
dialog on, "Don't let this page show more dialogs" stops them until the
next load. A page waiting on a dialog does not sleep.

**Agents answer as a person would.** `browser_snapshot` reports the dialog
(kind, who asks, its text) instead of reading a page that cannot answer;
`browser_act` answers with `press` Enter or Escape, fills a prompt with
`fill` on uid `dialog`, and any other action fails with the dialog's
report. An action that opens a dialog returns its report rather than
hanging. A sign-in is the person's: the agent is told to ask them. No tool
schema changed.

Alternatives: CDP dialog interception (Electron's own manager answers
first); `disableDialogs` (pages get instant answers, no question); a sync
wait for beforeunload in the page (Chromium's timeout overrides it);
window-modal dialogs (one page would hold the whole window again).

## Consequences

- Pages behave as in Chrome for dialogs and sign-ins, without blocking Work.
- The tab preload now loads in every frame of a tab; it does only dialog
  work there. The session preload, loaded there too, returns at once.
- A sandboxed frame without `allow-modals` can ask (the preload cannot see
  the sandbox flags); "Don't let this page show more dialogs" stops it.
- While "Leave site?" is open the page keeps running, unlike Chrome's.
  Redoing a page's form submission sends the form again from the page;
  a navigation the Navigation API did not announce (another site's frame
  navigating the top) is only allowed, not redone.
- Sign-in popups still show Electron's native alert and confirm; neither
  they nor extension views ask for HTTP sign-ins.
- Keeping a held tab close relies on Electron's internal
  `-before-unload-fired` event. Without it (a later Electron) the tab closes
  as it did before; `e2e/page-dialogs.e2e.ts` fails then.
