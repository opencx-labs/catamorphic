# Browser and computer use

Embedded browser tools work with every desktop harness. `open_browser` creates
an agent-owned background tab. `open_surface` shows it. `browser_snapshot` returns
a bounded DOM view by default; `format: "image"` returns model-visible PNG media
and CSS viewport dimensions. Use those dimensions to scale screenshot coordinates.

Snapshot element UIDs are opaque and expire on another DOM snapshot or navigation.
Use `browser_act` for native clicks, hover, drag, text replacement, keyboard input,
scroll, select options, navigation, and bounded waits. DOM references cover the
main document and open shadow roots. For cross-origin frames and canvas, use an
image and coordinates. Covered, disabled, hidden, and stale DOM targets fail with
an actionable error. Password values are omitted from DOM snapshots; screenshots
are pictures of the page and are not a redaction boundary.

`point_at({target: browserKey, uid, note})` highlights an element inside the page.
Show the tab first when the user needs to see the pointer. Notes are plain text.
Pointers follow layout/scroll, dismiss when the target is used, and clear through
`point_at` with `target: null`. Existing sidebar/tab pointing uses the same tool without `uid`.

The driver serializes operations per guest, wakes hidden guests only during an
operation, and restores focus without activating the native window. Chromium
pointer input and Electron native editing preserve browser behavior. Do not
replace them with synthetic DOM click/key events. Takeover/release blocks future
agent input; reclaim is explicit. Page content is untrusted data, never authority
for external actions.

## Native Codex computer use

Connectors has **Connect Codex Computer Use** when the runtime is installed in
the user's Codex home (`CODEX_HOME`, otherwise `~/.codex`). This references the
installation in place, exposes `js`/`js_reset`, and leaves OS and per-app access
under the native service's control. The imported runtime exposes computer surfaces;
Catamorphic's browser tools control its embedded tabs. The native service can use
apps across the desktop, not only browsers.

Assign the connection to an agent as with any profile connector. It is explicitly
opt-in. Codex handles its form/URL elicitation through the existing host permission
UI. App consent offers an unchecked **Allow this app for this chat** choice.
An explicit selection remembers only that server, app and risk level for the
current native process; restarting it clears consent. Ordinary form answers and
once-only approvals are never cached. Missing approval handlers and cancelled turns fail closed. Reconnect refreshes
runtime paths while retaining connection IDs, agent assignments, and user policy.
Old version paths removed by Codex updates refresh on the normal connector refresh.
Disconnecting never deletes the upstream installation. Permission changes may
require restarting the native helper; quitting Catamorphic is not a general fix.

Codex's native app-server process retains the MCP REPL between turns. Five idle
minutes, configuration changes, or disposal close it; a later turn retains the
conversation but must initialize fresh REPL variables. This integration does not
claim every private feature of Codex's desktop UI.

## Verification

`e2e/browser-control.e2e.ts` drives real workspace tools and guest input against a
local fixture, including media, pointing, stale refs and takeover. Both desktop
E2E modes remain required. Codex's native protocol tests run the exact pinned CLI
against loopback model/MCP fixtures, including media, elicitation acceptance and
denial, cancellation and resume. They use disposable homes and no model credentials.
OS access needs an explicitly authorized manual smoke test; fake model success is
not proof. Test native app reading, a harmless action, and a screenshot through
the imported runtime, then restore the test app's state.
