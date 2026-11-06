# 0272 — Profiles share settings with another profile, once or kept in sync

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

Each desktop profile owns its whole environment in `profiles/<id>/`: theme,
shortcuts, `workspace.js` and `prefs.json`. A person with a work and a personal
profile set everything twice, and nothing kept the two alike. A copy drifts. A
symlink breaks on the first save, because saves write a temporary file and
rename it over the original.

## Decision

**A profile imports parts of another profile's settings, once or kept in
sync.** The parts are the Settings categories that hold look and feel:
Appearance (`theme.json`, `codeTheme`, `terminalAppearance`), Workspace
(`workspace.js` and the Workspace preferences), Macros, Keyboard shortcuts
(`keybindings.json`) and Notifications. A preference's part is its Settings
category (`settingCategory`), so a new setting joins one without a second list.
Agents, connections, passwords, voice, history and browsing data never move.

**Kept in sync means shared files, not copies.** `profiles.json` records
`syncedFrom: { <part>: <owner profile id> }`. The profile's stores for that part
read and write the owner's files. Preferences are routed per key, because
`prefs.json` also holds runtime state (last project, sidebar pose) that stays in
each profile's own file. An edit from either profile is the same edit, applied
live by the existing file watchers. Followers always name the owner: syncing
with a follower links to its owner, and an owner that joins another profile
brings its followers along. Per-project overrides stay with each profile.

**Stopping keeps what the profile shows.** The follower takes a copy of the
part and owns it from then on. Deleting an owner does the same for its first
follower, and the others follow that one, so they stay in sync with each other.

**Where people choose it.** A new profile's welcome screen offers "Import from a
profile" beside "Import from a browser". Profile settings opens the same dialog
and lists what stays in sync, with Stop syncing. Settings notes under a shared
category which other profiles an edit there changes. `desktop_settings` gives
agents `sharedSettings` and the owner's paths.

Considered: an "All profiles" layer under every profile. It is more general, but
existing profile values would hide it and every settings card would gain a
scope. A copy-only import drifts, and symlinks break on save.

## Consequences

Desktop only: no framework, schema or wire change. A part's files live in one
profile's folder, and removing that profile hands them to a follower first.
Importing replaces the receiving profile's choices for the selected parts. An
edit in a synced profile changes the others, which Settings and the agent
context say.
