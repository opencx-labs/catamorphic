# Desktop settings

`src/shared/settings.ts` declares ordinary preference keys, labels, validation and
permitted scopes. `app-prefs.ts` supplies defaults and runtime preference shape.
`main/settings-store.ts` owns per-key resolution and atomic writes.

## Precedence and reset

For project-overridable settings, lowest to highest priority:

1. Built-in default.
2. Profile: `profiles/<id>/prefs.json`.
3. Shared project: `<project>/.work/settings.json`.
4. Personal project: `profiles/<id>/settings-projects/<projectId>.json`.

Layout, framed content, bookmarks presentation and link defaults support all three
editable scopes. Notifications, terminal appearance, terminal macros,
switching to a page's open tab (`switchToOpenTab`), browser tab sleep
(`browserTabSleep`, ADR 0194) and window buttons (`windowButtons`) are profile
choices. `SETTINGS` is the executable scope allowlist. A shared project
file is ordinary committed project configuration; a personal override never enters
team git history. Without a local project root, shared-file editing is unavailable.

Missing keys inherit; false is a valid explicit override. Reset deletes
one key from the selected layer. Never materialize inherited defaults while saving
an unrelated preference. Unknown keys survive writes. Malformed JSON and invalid known values are reported with the exact path; the
file retains its last valid configuration until repaired. A first invalid load
uses defaults, and deletion resets the layer. UI edits must not overwrite an
invalid file silently. Valid file edits apply live.

Settings > Workspace provides a scope selector, effective values at that scope,
source labels and Reset only for explicit choices. A profile edit can remain masked
by a project override. Reset that project override to follow the profile again.
Rows reserve space for Reset and source text across inherited and custom states,
so toggles and resets do not reflow nearby controls. Content padding and corner
radius preview with the standard 200 ms transition; reduced motion applies them
immediately. Framed content independently controls the inset window and its border.
Scope selectors wrap below headings when space is tight, and option controls
shrink within their rows so both sidebars can remain open without horizontal scroll.

## Other families

Settings > Workspace > Code review exposes `diffLayout`, `diffWrap`,
`reviewStartView` and `reviewGrouping`.
These are profile preferences in `prefs.json`, with reset and live file edits.
The code theme lives in Appearance as `codeTheme`. Review progress and explicit
checkout selection are runtime state, separate from presentation preferences.

| Family | Resolution |
|---|---|
| Workspace (`workspace.js`: sidebars, palette modes) | Built-in, profile, shared project, personal project; whole document |
| Theme | Profile, shared project, personal project; sparse selection, token and font overrides |
| Default agent | Profile, shared project, personal project |
| Voice (`voiceAssistant`, `voiceId`, `agentVoices`, `voiceMicrophone`, `voiceDictation`, `voiceShortcutsAsked`, `voiceInDock`, `voiceInChats`, `voiceBubbleSpot`, `voiceprint`) | Profile only, in `prefs.json`; a live voice follows edits from anywhere (ADR 0216, 0236) |
| Runtime state | Explicit owner, not inherited appearance configuration |

Do not apply generic object merging to workspace documents or themes. Credentials,
enforced permissions, last project, unread markers and sidebar pose are not ordinary
project-overridable settings. `ProfileConfigManager.forProject` identifies an owning
profile; `resolveSettings` resolves layers. These are different operations.

Project agents receive the `configuring-catamorphic-desktop` host skill, with
schema tables generated from the preference, theme and action registries. The
read-only `desktop_settings` workspace tool returns the initiating project's owning
profile, exact file paths, access mode and validation errors. It resolves the primary
project folder even when the session runs in a worktree or another profile is
foreground. Turn context carries only current validation errors (ADR 0152). Native
agents edit files directly with ordinary file/shell facilities; native permissions
still apply. Agents whose sandboxing is contained inspect only. Sandboxed agents without host filesystem
access must report that limitation. No settings write tools or mirrored
configuration transport exist.

`ConfigFile` retains each file's last valid JSON object. Profile-owned `SettingsStore`
instances resolve scoped preferences, and theme/shortcut stores use the same file
validation behavior. Settings reports errors above every category; subsequent agent
context reports them too. Do not treat metadata paths as filesystem authorization.

Tests: `settings-store.test.ts`, `config-file.test.ts`,
`desktop-settings-context.test.ts`, `settings-inheritance.e2e.ts`, and
`settings-palette.e2e.ts`.

## Palette destinations

The shared catalog supplies ordinary palette matches and the `settings` + Space
scope; the Settings page's search button and the `search-settings` action open
that same scope, and the page itself never filters. Destinations carry a stable
catalog id and a new request id, so opening an already-mounted Settings surface
reveals the control again. Every id resolves to one block: the Connections
category exposes `github-cli` and `connectors` rather than a category-wide
target. Navigation expands advanced colors when needed, waits for async
controls, scrolls, highlights and focuses the target. A floating chat minimizes so it cannot obscure
the control. Rows identify the inspected scope even when navigation passes its
section header. Navigation never changes a preference itself.

Project themes use the same profile, shared-project and personal-project priority
as workspace settings. Missing selections, colors and fonts inherit. Choosing a
selection replaces inherited color overrides; individual token and font edits
remain sparse. Theme edits use the shared configuration file validation and
last-valid-value caches. The pill's preferences (the dock's bubble strip, Settings' Pill section,
ADR 0242) are profile choices: `dockMultiProject`, `dockDetached`, `dockEdge`,
`dockFollowsWindow`, `dockIslandHover`, `dockSide`, and `dockPlacement`;
`dockDisplay` is the display it last docked on, kept by the app, not shown.
`dockDetached` puts the pill on the desktop, in a window of its own above every
app, and it stays there while Work is minimized. It is the launch default only:
right-clicking the collapsed bubble or the arrows floats the pill or returns it
for the current session, and closing its window returns it the same way. Those
actions never rewrite the preference, so a restart comes back with the chosen
default. Settings' picker writes the default and moves the pill at once.
`dockEdge` chooses the screen edge the pill docks on: `bottom` (default),
`left`, `right`, or `top`, which wraps the camera notch on a display that has
one (a black island that opens downward, on hover when `dockIslandHover` is on)
and sits under the menu bar elsewhere. Dragging the collapsed bubble or the
arrows moves the pill in two dimensions, onto any display; while it is held, a
display-wide overlay that never takes a click shows where it can land, and it
lands on the edge nearest where it was thrown. Arrow keys on those controls move
it to the spot that way, and the pill's menu docks it at an edge. At the bottom,
while a Work window is in front, the pill rests inside that window's chat
region, between the sidebars, unless `dockFollowsWindow` is off; when another
app is in front, or Work is minimized, it uses the display's work area.
Clicking into another app while the agent works lurks the chat until the pill
is focused again.
At the bottom, `dockPlacement` chooses `left`, `center` (default) or `right`
for open chats and their bubble strip; `dockSide` chooses the corner the
collapsed bubble rests in. Dragging along the bottom changes the corner or the
placement by the 40% rule, and an open chat collapses as the drag starts. The
window keeps its size while dragged and lands with its final size in one move.

## Workspace frame

Content sits flush with the sidebars by default. `contentFrame` (default false)
insets the workspace as a rounded window with a 1px border; `contentPadding`
(default 6px) and `contentRadius` (default 14px) are that frame's dimensions and
apply only while it is on. Dimensions accept 0 through 48px. Together with
`sidebarDividers` (default false) they support profile, shared project and
personal overrides, appear in settings search and apply live in every tab layout.

## Window buttons

`windowButtons` (default true) shows the macOS close, minimize and full screen
buttons at a workspace window's top left. A setting marked `macOnly` appears in
Settings (Workspace > Window) and the palette only on macOS, and the skill table
says so; elsewhere the OS draws the frame and the key changes nothing.
`main/window-buttons.ts` combines the preference with the workspace's own hiding
(a collapsed sidebar holding the header hides them until revealed). It applies
before a new window first shows and on every preference change, including file
edits, so an agent can turn them off. While they are hidden the chrome gives back
the corner it keeps for them: the sidebar's project switcher moves up into the
row beside its toggle, across it, unless the header shares that row. The
window then drags by the chrome's empty room, as Chrome's does (the tab
strip's spare end, or the title row). The menu bar still
closes (File > Close Window), minimizes and enters full screen.
