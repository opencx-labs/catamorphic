# 0203 — Work runs Chrome extensions from the Chrome Web Store

- **Status:** Accepted
- **Date:** 2026-10-06
- **Amends:** 0194 (the brand rewrite's request listener)

## Context

Work's browser loaded unpacked folders dropped into
`profiles/<id>/extensions/`, with no way to install, see, pin, configure
or remove them. Electron 44 runs extension code (MV2 and MV3 service
workers, content scripts in webview guests, `scripting`, `storage.local`
and `session`, `alarms`, `offscreen`, `declarativeNetRequest`, MV2
`webRequest`), but much of what popular extensions call is missing or a
no-op: `action` stubs, `tabs.create`, tab events, `windows`,
`permissions`, `contextMenus`, `commands`, `storage.sync`, `sidePanel`,
`debugger`, `tabGroups`, `webNavigation`, `notifications`, `downloads`,
`identity` and native messaging. uBlock Origin Lite and Dark Reader stop
at their first `chrome.permissions` call; the Claude and ChatGPT
extensions need a side panel and the page debugger. Electron also skips
indexing default static rulesets, and any `session.webRequest` listener
switches off extension `webRequest` and `declarativeNetRequest` for the
whole session. Our Sec-CH-UA brand rewrite (ADR 0194) is such a listener.

`electron-chrome-extensions` fills these gaps but is GPL-3.0 or a paid
patron license, which Work's Apache-2.0 release cannot take. The MIT
`electron-chrome-web-store` installs without checking CRX signatures.

## Decision

**Work hosts the Chrome extension API itself, on Electron's extension
system.** Extensions load only into a profile's browsing session
(`persist:profile-<id>`), never the app's own session. A session preload
for frames and service workers installs Work's `chrome.*` APIs in
`chrome-extension://` contexts only; every call goes to main, which names
the calling extension from the IPC sender (frame origin or worker scope),
never from arguments, and checks its permissions there. Tab ids are guest
`webContents` ids, so Electron's own `scripting` and `tabs.sendMessage`
agree with ours. The renderer reports each window's browser tabs (order,
active tab) so `tabs` and `windows` describe the workspace the person sees.

**Installs come from the Chrome Web Store and are verified like Chrome
does.** The store page gets `chrome.webstorePrivate` on its exact origin.
Work shows its own prompt with Chrome's permission warnings, downloads
the package from Google's update service, checks the SHA-256 the service
names, verifies every CRX3 signature, and requires the developer key that
derives the id plus the Web Store publisher key. The manifest it installs
may not ask for more than the person approved, compared as access (sites
and permissions), never as warning text. Updates are checked every five
hours; one that asks for more waits for the person, one for an extension in
use waits until it is idle, and one the person turned off stays off.
Installs, removals and permission requests need a user gesture, as in
Chrome. Developer mode adds "Load unpacked". Installed extensions,
pinning, granted optional permissions and `storage.sync` data are
per-profile files.

**The browser shows extensions as Chrome does:** pinned action buttons
with badges and popups, a puzzle menu, an Extensions page, install and
permission dialogs, context-menu items, keyboard commands, a side panel
beside the page, and a bar on any tab an extension is debugging. Debugger
access is one extension per tab, on web pages only: the session ends when
the page leaves the web (another extension's page, the Web Store), child
targets that aren't web pages are detached, and nothing reaches the browser,
other targets, local files or other sites' cookies. Native messaging runs hosts registered for Work or for Chrome
whose manifest allows the calling extension, so Claude and Codex can
reach their extensions.

**Network extensions keep working with the brand rewrite.** A profile
with an enabled extension that uses `webRequest` or
`declarativeNetRequest` drops the session listener and sets the same
Sec-CH-UA brands from a hidden built-in DNR extension. Other profiles
keep the listener, so pages there pay no extension proxy cost.

## Consequences

uBlock Origin Lite, Dark Reader, Claude and ChatGPT install from the store
and run. Classic uBlock Origin (MV2) is gone from the store; it loads
unpacked while Electron still runs MV2. Work owns a compatibility surface
that Chrome changes: new APIs or semantics need host work, and each one
must keep resolving the caller in main. Content scripts in cross-origin
extension frames inside pages get only Electron's native APIs.
Unsupported APIs (`userScripts`, `privacy`, `identity.getAuthToken`,
Chrome sync) stay absent rather than faked. The store page still shows
its "Switch to Chrome" note: since Chrome 142 it asks Google's servers,
which check a header only Google Chrome can produce. Work does not
imitate it; "Add to Chrome" works regardless.
