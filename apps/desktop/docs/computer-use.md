# Browser and computer use

Embedded browser tools work with every desktop harness and are direct tools
(ADR 0202). `open_browser` creates an agent-owned background tab. `open_surface`
shows it. `browser_snapshot` returns a bounded DOM view by default; `format:
"image"` returns model-visible PNG media and CSS viewport dimensions. Use those
dimensions to scale screenshot coordinates.

Snapshot element UIDs are opaque and stay valid while their element stays in the
page, across snapshots; an element that leaves, or a navigation, makes its UID
stale. Use `browser_act` for native clicks, hover, drag, text replacement,
keyboard input, scroll, select options, navigation, and bounded waits. DOM
references cover the main document and open shadow roots. For cross-origin frames
and canvas, use an image and coordinates. Covered, disabled, hidden, and stale DOM
targets fail with an actionable error; a covered one names what covers it (and
its UID when it has one), usually a dialog or banner to close first. A label over
its own control is not a cover. Password values are omitted from DOM snapshots;
screenshots are pictures of the page and are not a redaction boundary.

`upload` takes the UID of a file input or of the button that opens one, and
absolute file paths: the driver intercepts the page's own file chooser over CDP
and sets the files. Folder pickers and `showOpenFilePicker` are not intercepted;
the person answers those. Outside the agent's own folder, hidden files and
folders and `~/Library` (keys, tokens, keychains) are refused, symlinks
resolved, so page text cannot talk an agent into uploading them. `downloads`
lists the files this tab saved (recorded from the moment it opens, to the
profile's Downloads folder) with their paths and state; with `timeoutMs` it
waits for a download a click starts and for unfinished ones. For web
development, `evaluate` runs JavaScript in the page without a user gesture and
returns its JSON value, giving up after 30 seconds; `console` returns what the
page logged since the tab was last read (recorded for every tab from the moment
it opens), and `network` its requests (recorded, without bodies, from an
agent's first look, action or read; a pending request comes again until it
finishes, a redirect hop ends with its status). Evaluate and network bypass the
snapshot's password redaction, as screenshots do; agents upload, reveal or
paste only what the task needs.

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
installation in place, preserves its configured surfaces and exposes `js`/`js_reset`, and leaves OS and per-app access
under the native service's control. The imported runtime exposes computer surfaces;
Work's browser tools control its embedded tabs. The native service can use
apps across the desktop, not only browsers.

Assign the connection to an agent as with any profile connector. Connecting the runtime is explicitly
opt-in. Full-access local agents accept native app-consent requests without an
additional Work prompt. Codex and OS restrictions still apply. Restricted
agents retain the consent flow below. Codex handles its form/URL elicitation through the existing host permission
UI. App consent offers an unchecked **Allow this app for this chat** choice.
An explicit selection remembers only that server, app and risk level for the
current native process; restarting it clears consent. Ordinary form answers and
once-only approvals are never cached. Missing approval handlers and cancelled turns fail closed. Reconnect refreshes
runtime paths while retaining connection IDs, agent assignments, and user policy.
Old version paths removed by Codex updates refresh on the normal connector refresh.
Disconnecting never deletes the upstream installation. Permission changes may
require restarting the native helper; quitting Work is not a general fix.

Codex's native app-server process retains the MCP REPL between turns. Five idle
minutes, configuration changes, or disposal close it; a later turn retains the
conversation but must initialize fresh REPL variables. This integration does not
claim every private feature of Codex's desktop UI.

## Verification

`e2e/browser-control.e2e.ts` drives real workspace tools and guest input against a
local fixture, including media, pointing, lasting and stale refs, covers, uploads
through a hidden file input, console, network, evaluate, downloads and takeover. Both desktop
E2E modes remain required. Codex's native protocol tests run the exact pinned CLI
against loopback model/MCP fixtures, including media, elicitation acceptance and
denial, cancellation and resume. They use disposable homes and no model credentials.
OS access needs an explicitly authorized manual smoke test; fake model success is
not proof. Test native app reading, a harmless action, and a screenshot through
the imported runtime, then restore the test app's state.

The assigned computer-use server runs directly in the initiating Codex app-server,
not in the shared profile tool pool. Other profile connector catalogs remain
deferred. Full-access defaults permit tools without an explicit policy; saved
connection policies, agent restrictions and provisioner ceilings still intersect.
