import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
} from "../../shared/actions.js";
import { normalizePrefs } from "../../shared/app-prefs.js";
import { SETTING_KEYS, SETTINGS } from "../../shared/settings.js";
import { THEME_TOKENS } from "../../shared/theme-tokens.js";
import { THEME_PRESETS } from "../theme.js";
import { WORKSPACE_AUTHORING_GUIDE } from "../workspace-authoring.js";

/** Text as one Markdown table cell. */
const tableCell = (text: string) => text.replaceAll("|", "\\|");

/** Delivered through the host skill tier, including existing user projects. */
export const DESKTOP_SETTINGS_SKILL = `---
name: configuring-catamorphic-desktop
title: Configure desktop settings
description: Edit Work desktop configuration files to customize theme, fonts, shortcuts, sidebar sections and command palette modes (workspace.js), tabs, notifications, terminal macros or browser bookmarks, including project overrides and reset.
---

# Configure the desktop

Call the desktop_settings tool for this project's owning profile, exact host
file paths, access mode and current validation errors. When it is not loaded,
discover_capabilities({ query: "desktop settings" }) finds it as
workspace.desktop_settings; call it with invoke_capability. Use those paths, not the foreground profile, a guessed home
directory, a sandbox path, or a session worktree's .work folder. Read the relevant files first;
a missing file is an empty object inheriting defaults. Read this skill for the file
schema. Edit with ordinary file or shell facilities, preserving unrelated keys.
Prefer writing a complete JSON object to a temporary sibling and renaming it over
the original. Read back your change and report its actual scope.

Scopes name layers, not folders: "personal" means files.*.personal from
desktop_settings (outside the repository), never the project's personal
documents directory (.work/personal), which holds documents, not settings.
A configuration file anywhere else is not read.

Paths are metadata, not permission grants. An agent whose sandboxing is
contained may inspect but must not edit. Native harness filesystem permissions still apply outside the checkout.
If host access is unavailable, explain that limitation. A file created inside a
sandbox does not configure the desktop; do not introduce a mirror directory.

## Preferences: JSON objects, per-key inheritance

The preferences paths have three editable scopes, from low to high precedence:
profile, project (shared), personal (just this project for this user). Missing keys
inherit the next lower layer, ultimately the app default. false is an explicit
choice. To reset, DELETE the key from the chosen JSON object; do not write null or
copy today's default. Deleting a file resets that whole layer.

Use profile for app-wide requests, personal for 'just this project for me', and
project for an explicitly shared team default. The shared settings file lives in
the primary project folder's .work/settings.json and may enter git. Personal
overrides live outside the repository. Higher layers can mask profile edits; read
all relevant layers before claiming the effective value changed. Runtime keys in
prefs.json (sidebar pose, last project, window/session state) are not preferences;
preserve them, and do not copy them into project overrides.

Each row gives the setting's label in Settings and, where Settings has one, its
description; option values carry their Settings labels. Tell the person what a
change does from these words, not from a key's name. When no value does what they
asked, say so and change nothing unless they choose the closest one.

| Key | In Settings | Value | Editable scopes | App default |
|---|---|---|---|---|
${SETTING_KEYS.map((key) => {
  const definition = SETTINGS[key];
  const value =
    "range" in definition
      ? `number (${definition.range.min} through ${definition.range.max})`
      : "options" in definition
        ? Object.entries(definition.options)
            .map(([option, label]) => `${JSON.stringify(option)} (${label})`)
            .join(" or ")
        : key === "terminalMacros"
          ? "array of macros (below)"
          : "boolean";
  const meaning =
    "description" in definition
      ? `${definition.label}: ${definition.description}`
      : definition.label;
  return `| ${key} | ${tableCell(meaning)} | ${tableCell(value)} | ${definition.scopes.join(", ")} | ${JSON.stringify(normalizePrefs({})[key])} |`;
}).join("\n")}

Example: {"tabPlacement":"top","contentFrame":false} chooses regular top tabs
with content flush against the sidebars; contentFrame true insets it as a
rounded, bordered window sized by contentPadding and contentRadius. headerPlacement applies to the sidebar tab layout. Terminal
appearance changes apply to newly opened terminals.

terminalMacros is a replacement array. Preserve unrelated entries. Each macro has
unique nonempty id, nonempty name and command strings, and a shortcut string.
Example: [{"id":"dev","name":"Dev server","command":"bun run dev","shortcut":""}].
An empty shortcut leaves a macro unbound. Bound macros need a modifier or F key;
avoid collisions with other macros and the keybindings file. Saving never runs a
macro. Removing a macro does not kill its running terminal.

## Theme: scoped JSON

Shape: {"selection":"system","overrides":{},"fonts":{}}. All keys are optional.
selection is "system" or one of: ${THEME_PRESETS.map((preset) => JSON.stringify(preset.id)).join(", ")}.
The profile theme file is a theme object. Shared and personal project files store
that same object under the theme key beside ordinary preferences. Use the supplied
theme paths. Precedence is profile, shared project, then personal project. Missing
keys inherit; deleting the project theme object resets that scope. System follows
the operating system live. A new selection resets inherited color edits; font and
individual color edits remain sparse. Delete profile selection to reset to system. overrides maps the following tokens to CSS colors:
${THEME_TOKENS.join(", ")}.
Use hex, rgb/rgba, hsl/hsla or oklch colors. Example:
{"selection":"system","overrides":{"accent":"#ff5500"}}.
fonts accepts sans and mono CSS font-stack strings, e.g. {"mono":"'JetBrains Mono', monospace"}.
Use installed font names and generic fallbacks; do not use url() or CSS declarations.
Delete just the affected token or font key to restore its inherited value. Preserve
unrelated preference keys when editing a project settings file.

## Keyboard shortcuts: profile JSON

The object maps action ids to binding strings. Modifiers are Cmd, Ctrl, Alt and
Shift, joined with + and followed by a key, e.g. "Cmd+Shift+P". Cmd maps to Control
outside macOS. Keys may be a character, Enter, Escape, Tab, Space, Backspace, Delete,
Insert, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Plus, or F1 through F24.
An empty string disables an action; delete its key to restore the default. Keep
bindings unique. Defaults and supported action ids:
${KEYBINDING_ACTIONS.map((action) => `- ${action}: ${JSON.stringify(DEFAULT_KEYBINDINGS[action])}`).join("\n")}

## Bookmarks: one JSON file

files.bookmarks from desktop_settings holds every bookmark. byProject[projectId]
is this project's tree (the sidebar's This project section) and
pinnedByProfile[profileId] the bookmarks that follow the profile across projects
(Pin across projects); use the projectId and profileId desktop_settings returns.
libraryByProfile holds imported browser bookmarks: leave it to the import flow.
Each tree is { "folders": [...], "bookmarks": [...] }. A bookmark is
{ "id", "label", "url", "folderId"? }, a folder { "id", "label", "parentId"? };
ids are any unique string and folderId/parentId name a folder of the same tree.
To bookmark the page the person is looking at, take its URL and title from the
turn context or read_tab and append it; omit position to place it last. Keep
every other key and tree as it is, write the whole file to a temporary sibling
and rename it over the original. Valid edits show in the sidebar at once, and
the app's own changes build on them. An invalid file (not JSON, or a tree of the
wrong shape) keeps the last valid bookmarks, is named in Settings, and blocks
bookmark changes in the app until it is fixed.

${WORKSPACE_AUTHORING_GUIDE}

## Validation and boundaries

Valid edits apply live. Invalid JSON or invalid known preference/theme/shortcut
values leave the last valid configuration active and show a file-specific error
in Settings, desktop_settings, and the next turn's context. On a fresh app start, a file
with no previously valid value uses defaults until repaired. Fix the file before
making unrelated UI edits; do not interpret a fallback as a successful update.

Agent credentials, connection authentication and browser imports use their host
setup flows. Never edit credential stores or invent scalar preference keys for
those flows. Committed agent behavior follows the project's agent-authoring guide.
The palette searches settings normally; type settings then Space or Tab to search
only settings. Enter opens and highlights the target without changing its value.
The palette ranks by match, kind and use: open tabs first, then commands, app
surfaces and the items the sidebars list, then bookmarks, then pages; frequently
used destinations first, and rows the user picked for a query earlier. Type tabs
then Space to list only open tabs. A source a sidebar section shows lifts its rows,
so adding or removing a section in workspace.js changes their rank; otherwise the
palette learns from use on its own. Do not try to tune ranking any other way.
`;
