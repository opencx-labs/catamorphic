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
`runtime.getContexts`/`openOptionsPage`/`setUninstallURL` and native
messaging. Anything else is absent rather than faked; a call to it fails
with "not supported in Work".

- **Rulesets.** Electron does not enable a manifest's default static
  rulesets. The preload's synchronous boot answer enables them, at install
  and after each update, before the extension's code can read them.
- **Brand headers.** Any `session.webRequest` listener stops extension
  `webRequest` and `declarativeNetRequest` for the whole session. A profile
  with an extension that filters requests drops the Sec-CH-UA listener and
  loads the hidden brand extension (`main/extensions/brand.ts`) instead. Do
  not add another `webRequest` listener to a browsing session.
- **Debugger.** Only web pages, only the tab's own target: no `Browser`,
  `Target` (beyond auto-attaching its frames), tracing, memory, file input,
  download or certificate commands, and `Page.navigate` only to web
  addresses. The tab shows who is controlling it, with Stop.
- **Native messaging.** Hosts registered for Work
  (`<userData>/NativeMessagingHosts`), Google Chrome or Chromium, when the
  host's manifest names the calling extension and the extension has
  `nativeMessaging`. The host runs without a shell, given the caller's
  origin, as Chrome runs it.
- **Workers.** An event a stopped service worker listened to starts it
  again and waits until it listens. Events, API calls, debugger sessions
  and native ports keep it alive while they last.

## Installing and updating

The store page gets `chrome.webstorePrivate` on its exact origin. "Add to
Chrome" asks main, which shows Work's dialog with Chrome's warnings,
downloads the package from Google's update service, checks its size and
SHA-256, verifies every CRX3 signature, and requires the developer key that
derives the id and the Web Store publisher key. The installed manifest may
not ask for more than the person approved. Updates are checked at start and
every five hours; one that adds warnings turns the extension off until the
person accepts. Developer mode loads unpacked folders, which stay where
they are and are never deleted.

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
