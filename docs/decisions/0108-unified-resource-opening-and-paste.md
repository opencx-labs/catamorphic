# 0108: Unified resource opening and composer file paste

- **Status:** Accepted
- **Date:** 2026-09-09
- **Refines:** 0105, 0107

## Context

Sidebar resources, palette results, message links, and attachment cards interpret
modifiers differently. Pathless clipboard files can disappear when an agent cannot
accept their media type.

## Decision

Use one opening intent everywhere the desktop opens a resource: plain click/Enter
opens here, Cmd+click/Enter opens a tab, Cmd+Shift+click/Enter opens beside the
current pane, and Option+click/Enter opens floating. Ctrl substitutes for Cmd on
Windows/Linux. Explicit modifiers override an item's configured default. The
palette New Tab page consumes its own placeholder. Remove the float-current-tab
action and Cmd+Option+F shortcut.

Open here navigates the current compatible browser/editor when safe, otherwise
focuses or opens the resource in the current pane. Dirty editors and running
sessions remain intact. Existing workspace-tab entries activate their existing
instance; side and floating reposition that instance. Ordinary tab activation
never clones a running terminal or chat. Folders, disclosures, profile switching,
and non-navigation commands retain their ordinary actions. Resource context menus
expose the same four opening choices. Explicit webpage-link gestures take priority
over popup preferences; unmodified page navigation and downloads remain native.

Pasted, dropped, and picked files use one attachment path. Supported media within
budget can go directly to the model. Other files become path attachments; files
without an OS path are saved in the current project's local attachment directory
before inserting a pill. That path is real and available to the local agent.
Transfers preserve draft/caret, serialize writes, report failures, and prevent
sending while an attachment is still being prepared. Plain/rich text paste,
selection metadata, and native undo remain supported.

## Consequences

Opening modes belong in the desktop's shared contract, not the palette component.
New resource rows must forward intent to the existing workspace opening routines.
Local attachment files are user work and are not deleted when a pill is removed.
