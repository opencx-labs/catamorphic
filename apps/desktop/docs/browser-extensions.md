# Browser extensions

Work's browser runs Chrome extensions from the Chrome Web Store
([ADR 0203](../../../docs/decisions/0203-work-runs-chrome-extensions-from-the-web-store.md)).
This page is the contract: where things live, what the host promises
extensions, and what changes when you touch the code.

## Shape

| Part | Where |
|---|---|
| Per-profile list, pins, granted permissions, pending updates | `profiles/<id>/extensions.json` (`main/extensions/registry.ts`) |
| Store packages, unpacked per version | `profiles/<id>/extensions/<id>/<version>_0/` |
| `chrome.storage.sync` data | `profiles/<id>/extensions/<id>/sync-storage.json` |
| Loading, routing, install and update | `main/extensions/host.ts` |
| The `chrome.*` methods Work answers | `main/extensions/api.ts` |
| Package verification and unpacking | `main/extensions/crx.ts`, `archive.ts` |
| Session preload (extension contexts and the store page) | `preload/session.ts`, `extension-api.ts`, `webstore-api.ts` |
| Toolbar, popup, side panel, dialogs, Extensions page | `renderer/components/extensions/`, `renderer/screens/extensions-screen.tsx` |

Extensions load only into a profile's browsing session
(`persist:profile-<id>`), as that session is prepared and before its first
tab loads. The app's own windows use the default session and never see an
extension.

## Calls and identity

The session preload runs in every frame and service worker of a browsing
session. It acts only in `chrome-extension://` contexts (and on the store
page), and installs the APIs before the extension's own code runs. Every
call goes to main, which names the extension from the IPC sender (the
frame's origin, or the worker's scope) and checks the permission there.
Never trust an extension id, tab id or URL an extension passes without
checking it against the caller's profile and permissions.

Tab ids are guest `webContents` ids, which Electron's own `scripting`,
`tabs.sendMessage` and `tabs.executeScript` also use. Windows report their
browser tabs (`extensions-tabs-report`); a window's active tab is the last
browser tab used in it. A tab's address, title and icon reach an extension
with `tabs`, host access to the page, or `activeTab` after the person used
the extension on that tab.

## What Work provides

Electron supplies `runtime`, `storage.local`/`session`, `scripting`,
`alarms`, `offscreen`, `i18n`, `declarativeNetRequest`, `webRequest` (MV2)
and content scripts. Work adds `tabs`, `windows`, `action` (and MV2's
`browserAction`/`pageAction`), `permissions`, `contextMenus`, `commands`,
`storage.sync`, `sidePanel`, `debugger`, `tabGroups`, `webNavigation`,
`notifications`, `downloads`, `identity.launchWebAuthFlow`, `cookies`, read
only `bookmarks`, `history` and `topSites`, `fontSettings.getFontList`,
`runtime.getContexts`/`openOptionsPage`/`setUninstallURL`,
`management.uninstallSelf`, `sessions` and native messaging. Anything else
is absent; a call to it fails with "not supported in Work". A few answers
stand in for what Work doesn't have: `sessions` has no recently closed tabs
or other devices, `runtime.requestUpdateCheck` says there is no update (the
store check runs on its own), and `fontSettings` reports default fonts.

- **Who is calling.** Main names the extension from the IPC sender and
  answers with data (`{result}` or `{error}`, Chrome's `lastError`), never
  a thrown IPC error. `permissions.request` needs a user gesture: the
  frame's own activation, read in the preload's world where the extension
  can't change it, or, for a worker, an event the person caused (its
  button, a command, a menu item, a notification) in the last five seconds.
- **activeTab.** Work's grant covers the APIs Work answers (`tabs`,
  `captureVisibleTab`, cookies). Electron's own `scripting` checks
  Chromium's permissions, which never see it: injecting a script still
  needs host access.

- **Rulesets.** Electron neither enables a manifest's default static
  rulesets nor reliably keeps an extension's choice. Main keeps it
  (`enabledRulesets`, reset to the defaults by an update, as Chrome does);
  the session preload restores it as the extension starts and reports each
  change the extension makes.
- **Context menus.** Items live in main and are saved per version, so an
  extension that creates them once at install still has them after a
  restart; creating one again replaces the saved item.
- **Brand headers.** Any `session.webRequest` listener stops extension
  `webRequest` and `declarativeNetRequest` for the whole session. A profile
  with an extension that filters requests drops the Sec-CH-UA listener and
  loads the hidden brand extension (`main/extensions/brand.ts`) instead. Do
  not add another `webRequest` listener to a browsing session.
- **Debugger.** One extension per tab, and only on web pages: the session
  ends as the page leaves the web, directly or through a redirect (another
  extension's page, the Web Store, a local file), and child targets that
  aren't web pages are detached before the client hears of them. Other
  extensions' content-script worlds stay hidden: their contexts aren't
  reported, and commands naming them (by context or object id) fail. No
  `Browser`, `Target` beyond auto-attaching (flattened) frames, `Debugger`
  or `HeapProfiler` (both reach every world in the page), tracing, memory,
  file inputs or file drags, other sites' cookies, downloads or certificate
  commands; `Page.navigate` only to web addresses. `Target.closeTarget` on
  the tab itself closes it as a tab. A tab Work's own browser
  driver holds is shared, and the extension's end detaches it all the
  same, so nothing it set up stays. The tab shows who is controlling it,
  with Stop.
- **Native messaging.** Hosts registered for Work
  (`<userData>/NativeMessagingHosts`), Google Chrome or Chromium, when the
  host's manifest names the calling extension and the extension has
  `nativeMessaging`. The host runs without a shell, given the caller's
  origin, as Chrome runs it, and stops when the page or worker that opened
  it goes away.
- **Popups.** A popup takes focus once it shows. Escape or a press in any
  other page of the window closes it, as does focus leaving it: a page can
  take focus back while it loads, since a window's guests share its focus.
- **Workers.** An event a stopped service worker listened to starts it
  again and waits until it listens. A worker runs its script and listens
  while still starting, but Electron delivers nothing to it until it is
  running: events wait for that. Events, API calls, debugger sessions and
  native ports keep it alive while they last.
- **Lifecycle.** Electron fires neither `runtime.onInstalled` nor
  `runtime.onStartup`. Work does, to the background context (the worker, or
  an MV2 background page): `install` or `update` (with `previousVersion`)
  once per version, the first time it listens, and `onStartup` once per run
  for one installed before. Extensions set themselves up there: ChatGPT
  names its browser instance, and without it Codex has no browser to drive.
- **Storage.** `storage.local` and `session` are Electron's, `sync` is
  Work's, and `managed` is an empty area (no administrator policy).

## Agents that drive the browser

The Claude and ChatGPT extensions are how those agents use a browser, and
both work in Work as in Chrome, through native messaging:

- **ChatGPT** (Codex): the Codex app's Chrome plugin registers its host for
  Chrome (`com.openai.codexextension`), which Work reads. The side panel
  chats with your local Codex login, and Codex drives the tab through the
  extension's debugger. Codex must have its Chrome plugin enabled; an
  update of the plugin while a host runs needs the side panel (or Work)
  reopened.
- **Claude**: the Claude app registers `com.anthropic.claude_browser_extension`
  for Chrome. The extension signs in to claude.ai in a tab (its redirect to
  `chrome-extension://…/oauth_callback.html` is caught by its
  `webNavigation.onBeforeNavigate` listener), then Claude can drive the tab.

Neither reads anything from Chrome itself: sign-ins happen in the Work
profile, and hosts run as Chrome would run them.

## Installing and updating

The store page gets `chrome.webstorePrivate` on its exact origin. "Add to
Chrome" asks main, which shows Work's dialog with Chrome's warnings,
downloads the package from Google's update service, checks its size and
SHA-256, verifies every CRX3 signature, and requires the developer key that
derives the id and the Web Store publisher key. The installed manifest may
not ask for more than the person approved, compared as access (sites a
pattern covers, permissions that warn), never as warning text. Updates are
checked a minute after the profile opens once five hours have passed, then
every five hours. One that asks for more turns the extension off until the
person accepts; one for an extension in use (a popup or side panel open, a
debugger session, a native host) is downloaded and waits beside it, fires
`runtime.onUpdateAvailable` once, and goes in when the extension is idle,
reloads or next starts; one the person turned off stays off. Installs,
turning on or off and removals from the store page need a click there.
Developer mode loads unpacked folders, which stay where they are and are
never deleted.

The store page shows "Switch to Chrome to install extensions and themes"
even so. For Chrome 142 and later its script asks Google's servers, which
recognize Chrome by a validation header derived from keys built into
Google Chrome. Work does not imitate that header; the store's buttons
work without it.

## Tests

`src/main/extensions/*.test.ts` cover packages, archives, manifests,
policies and storage. `e2e/extensions.e2e.ts` loads a fixture extension
unpacked and installs another from a local stand-in store signed by a test
publisher key (`CATAMORPHIC_E2E_WEBSTORE_*`, honored only in E2E runs).
Real store extensions need the network and an account for some; check
uBlock Origin Lite, Dark Reader, Claude and ChatGPT by hand after changes
to the API surface.
