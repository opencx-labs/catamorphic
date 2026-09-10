# Desktop settings

`src/shared/settings.ts` declares ordinary preference keys, labels, validation and
permitted scopes. `app-prefs.ts` supplies defaults and runtime preference shape.
`main/settings-store.ts` owns per-key resolution and atomic writes.

## Precedence and reset

For project-overridable settings, lowest to highest priority:

1. Built-in default.
2. Profile: `profiles/<id>/prefs.json`.
3. Shared project: `<project>/.catamorphic/settings.json`.
4. Personal project: `profiles/<id>/settings-projects/<projectId>.json`.

Layout, tab frame, bookmarks presentation and link defaults support all three
editable scopes. Notifications, terminal appearance and terminal macros are
profile choices. `SETTINGS` is the executable scope allowlist. A shared project
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
so toggles and resets do not reflow nearby controls. Tab frame previews its inset
with the standard 200 ms transition; reduced motion applies it immediately.

## Other families

Settings > Workspace > Code review exposes `diffLayout`, `diffWrap`,
`reviewStartView`, `reviewGrouping`, `changesFileLayout` and `prDefaultView`.
These are profile preferences in `prefs.json`, with reset and live file edits.
The code theme lives in Appearance as `codeTheme`. Review progress and explicit
checkout selection are runtime state, separate from presentation preferences.

| Family | Resolution |
|---|---|
| Sidebar contents | Built-in, profile, shared project, personal project; whole document |
| Theme | System-following or explicit profile preset, then profile token/font overrides |
| Default agent | Profile, shared project, personal project |
| Runtime state | Explicit owner, not inherited appearance configuration |

Do not apply generic object merging to sidebar documents or themes. Credentials,
enforced permissions, last project, unread markers and sidebar pose are not ordinary
project-overridable settings. `ProfileConfigManager.forProject` identifies an owning
profile; `resolveSettings` resolves layers. These are different operations.

Project agents receive the `configuring-catamorphic-desktop` host skill, with
schema tables generated from the preference, theme and action registries. Each
turn's `desktop_settings_context` supplies the initiating project's owning profile,
exact file paths, access mode and validation errors. It resolves the primary project
folder even when the session runs in a worktree or another profile is foreground.
Native agents edit files directly with ordinary file/shell facilities; native
permissions still apply. Read-only agents inspect only. Sandboxed agents without
host filesystem access must report that limitation. No settings tools or mirrored
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
scope. Destinations carry a stable catalog id and a new request id, so opening an
already-mounted Settings surface reveals the control again. Navigation clears
filters, expands advanced colors when needed, waits for async controls, scrolls,
highlights and focuses the target. A floating chat minimizes so it cannot obscure
the control. Rows identify the inspected scope even when navigation passes its
section header. Navigation never changes a preference itself.

## Workspace frame

Workspace settings expose `sidebarDividers` (default false), `contentPadding`
(default 6px) and `contentRadius` (default 14px). Dimensions accept 0 through 48px,
including square corners and no inset. They support profile, shared project and
personal overrides, appear in settings search and apply live in every tab layout.
