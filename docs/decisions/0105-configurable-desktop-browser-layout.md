# 0105 - Configurable desktop browser layout

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

The desktop should support the light browser layout shown in Arc and Aside:
pinned favorites, bookmark folders, vertical tabs, and a profile switcher at
the bottom. Users also want to retain control over the arrangement and theme.
The desktop already owns profile preferences, layered sidebar sections,
bookmarks, and a single ordered workspace-tab model.

## Decision

Keep one tab model and render it horizontally or vertically according to the
profile's `tabPlacement` preference. Existing profiles retain top tabs.
Sidebar mode keeps all tabs in the sidebar even when collapsed. Its single
header shares the sidebar background with no separating border. A separate
`headerPlacement` preference places the title and address bar above the
content or inside the sidebar, with navigation beside the window controls.
Both use portals from the active browser. Sidebar chrome leaves the content
full-height; Cmd+L reveals a collapsed sidebar before focusing its address.
Switching layouts never remounts the browser guest. Keyboard shortcuts and
the palette continue to reach open surfaces. Tab order, groups, signals,
and split views continue to use the same workspace state. Collapse lives in
the sidebar. When sidebar chrome is hidden, content fills the window without
frame insets or an inner corner mask. Hovering the left edge or focusing
its reveal button opens the sidebar as an overlay. Focus and sidebar menus
hold it open; leaving dismisses it. Native window controls follow its
visibility. Hover never changes the saved preference or resizes the page;
the toggle pins it open, and Cmd+B remains available when hidden.
Top-header layouts retain their existing row. Empty New Tab pages leave
the sidebar-mode top header blank.

The profile's `pinnedBookmarks` preference selects icon tiles or list rows.
Project folders remain one level deep; deleting a folder moves its bookmarks
to the root. The profile switcher remains anchored below the scrollable
sidebar beside compact Settings and customization controls. A compact menu
retains profile creation, renaming, and default selection. Existing custom
sidebar section order remains authoritative.

The light preset uses cool neutral surfaces and an independent `sidebar`
color token. Layout settings are exposed in Settings and an agent-editable
`layout.json` mirror using the existing desktop configuration mechanism.
This is desktop doctrine, with no new framework dependency or schema.

Floating surfaces also keep the same workspace key and mounted browser,
terminal, or editor. A floating key overlays an anchor tab; expanding or
splitting changes geometry, while closing remains the disposal boundary.
Floating terminal tools reuse one shell per project, with a configurable
Git command run only at creation. Option-click previews and new-window
link disposition are per-profile preferences. Every application action,
including browser and floating controls, uses one configurable shortcut
registry in the host and its guests. Popups target only the owning window.
The palette has one entry per target. Its configurable "Open as floating"
shortcut opens the selected target as an overlay; outside the palette it
floats the current tab. Direct floating-tool shortcuts remain configurable
without adding duplicate palette commands.

Terminal appearance can follow the app or the installed Ghostty's resolved
configuration. This optional desktop-only integration reads colors and fonts
through Ghostty's CLI; it does not import commands, shortcuts, or native
window effects. The login shell remains unchanged. Appearance applies when
a terminal opens because the embedded VT renderer fixes colors at creation;
changing a preference never restarts a running shell.

Bookmark drops store stable URLs or local project/session links, never
ephemeral workspace keys. Favorites are profile-wide and folders project
scoped. Moving an existing target retains its bookmark identity.

## Consequences

Users can combine either tab arrangement with any theme and bookmark style.
Both arrangements must preserve keyboard, grouping, and close behavior.
The extra mirror exposes only presentation preferences; agent edits cannot
replace unrelated notification or relaunch state through that file.
