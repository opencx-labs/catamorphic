# Desktop settings

Executable sidebar, palette and chip sources declare their access in
`catamorphic.access` in the nearest `package.json`. Work asks before they
run with that access and when it grows. File grants bind their resolved
destinations; changing a symlink's target asks again. Modules run confined
on macOS and Linux, with only declared hosts through a proxy and no inherited keys.
They cannot reach Work's own servers, even through a DNS or loopback alias.

Chat hosts declared in `.work/project.json` become shared trust only in the
project's approved published program. Every person uses that list automatically;
local drafts and checkpoint commits do not widen it. Without a publication,
Work uses its built-in hosts and the person's own trusted hosts.

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

## Shared profile settings

A profile can import parts of another profile's settings, once or kept in sync
(ADR 0272): Appearance, Workspace, Macros, Keyboard shortcuts and
Notifications, the Settings categories `shared/profile-sync.ts` lists. A
preference belongs to the part named by its Settings category
(`settingCategory` in `shared/settings-catalog.ts`). `profiles.json` records
`syncedFrom: { <part>: <owner id> }` per profile; followers always name the
owner. A synced profile's theme, shortcut and workspace stores open the owner's
`theme.json`, `keybindings.json` and `workspace.js`. Its `PrefsStore` and the
profile settings layer read and write the part's preference keys in the owner's
`prefs.json` (`SettingsFiles.synced`), while runtime state and other keys stay
in its own. Per-project overrides (`settings-projects/`, `workspace-projects/`)
are never shared.

`ProfileConfigManager.syncSettings` links or copies parts;
`stopSyncing` gives the follower a copy and ends the link; removing an owner
hands its parts to the first follower and repoints the rest. Each swaps the
affected profiles' stores in place and repaints their windows. A copy never
overwrites an invalid `prefs.json`. The welcome screen and Profile settings
mount the same `ProfileImportDialog`; Settings shows `SyncedNote` under a shared
category; `desktop_settings` reports `sharedSettings`. Tests:
`profile-sync.test.ts`, `desktop-settings-context.test.ts` and
`profile-settings-screen.test.tsx`.

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

App-themed terminals use the nearest resolved project theme and its monospace
font, including shared and personal project overrides. The appearance provider
loads only the profile's source choice and optional Ghostty configuration; it
does not resolve app colors outside a project's theme scope. A new terminal
waits for that scope to load. Existing shells retain their opening colors
because the embedded terminal engine fixes its palette when opened; font edits
apply live without restarting a shell. Choosing Ghostty remains an explicit
profile-wide appearance choice.

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
last-valid-value caches. The dock preferences are profile choices:
`dockMultiProject`, `dockDetached`, `dockSide`, and `dockPlacement`.
`dockDetached` is the launch default only: right-clicking the collapsed bubble
or the arrows floats the dock in its own window or returns it for the current
session, and closing the detached window returns it the same way. Those actions
never rewrite the preference, so a restart comes back with the chosen default.
In the detached window those menus are native, and dragging shows no resting
spots because the window itself moves. While a Work window is in front the
detached dock rests inside that window's chat region, between the sidebars;
when another app is in front it uses the display's work area. Clicking into
another app while the agent works lurks the chat until the dock is focused
again.
`dockPlacement` chooses `left`, `center` (default) or `right` for open chats and
their bubble strip; `dockSide` chooses the bottom corner the collapsed bubble
rests in. Dragging the collapsed bubble changes the corner; dragging the
arrows of an expanded strip changes the placement, and an open chat collapses as
the drag starts. The detached window keeps its size while dragged and lands
with its final size in one move.

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
