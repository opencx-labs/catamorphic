# 0102: Tabbed sidebars and compact app widgets

- **Status:** Accepted
- **Date:** 2026-09-08
- **Builds on:** 0037, 0048, 0049, 0092

## Decision

The desktop owns two equally customizable sidebars. One `sidebar.js` exports
`left` and `right` arrays of tabs. Each tab has a stable id, accessible title,
optional Lucide icon, and ordered sections with stable ids, unique across the layout. Existing layered
resolution selects the whole layout; there is no merging or legacy shape.
Either side may be empty. Project targeting remains presentation only.

Icon tabs have no borders, backgrounds or visible text. The active icon uses
the host accent; inactive icons use secondary text. Tabs support arrow keys,
Home/End, tooltips and accessible names. Each side independently persists its
width and selected tab for the profile/project. Widgets initialize on first
use and remain mounted across tab switches. Config reloads preserve keyed
instances, crossfade the sidebars, and retain the last valid layout on errors.
Reduced motion bypasses structural animation.

Defaults place project navigation and files on the left; activity, a pinned
project note and nonempty changes on the right, with pull requests in another
tab for builders. Activity links to ordinary sessions/runs and does not
replicate the session inspector.

Custom widgets are ordinary project apps, mounted through `AppMount` with a
compact presentation. They retain the existing build pipeline, authorization,
storage and host tokens. Sidebar placement adds no workspace permissions.
The mount conveys presentation/visibility; apps may pause refreshes while
hidden. Expanding opens the same app in a workspace tab. Layout config never
executes app code in Electron's privileged renderer.

## Consequences

One sidebar model serves both sides and existing built-in sections. No new
widget runtime, database entity, package or workflow dialect is introduced.
Desktop defaults remain host doctrine; compact app mounting stays reusable.
