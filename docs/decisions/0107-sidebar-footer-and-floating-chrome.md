# 0107: Sidebar footer and floating chrome

- **Status:** Accepted; editor palette paragraph superseded by [0112](0112-review-navigation-and-code-rendering.md)
- **Date:** 2026-09-08
- **Builds on:** 0081, 0102, 0105

## Context

Integrating the browser workspace PR with tabbed sidebars moved customization
away from the footer and made the default sidebar busier than intended.

## Decision

Keep the shared tab/section primitive, with the browser PR's sidebar styling.
The default left sidebar has one Project tab containing its navigation,
bookmarks, open workspace tabs in sidebar mode, and collapsible files.
A side with a single tab hides its icon strip; multiple icons are horizontally
centered. Profile selection, customization, and Settings remain in the fixed
left footer regardless of the selected sidebar tab. The right sidebar has no
customization icon. An empty sidebar offers a centered Add tab action that
opens the existing customization chat.

Floating surfaces keep their mounted content and paired 200ms entrance/exit
motion, including reduced motion support. A compact group of controls sits
at the upper right, using the same placement as other workspace surfaces;
there is no separate floating title bar. Hiding preserves the surface,
expanding and tiling preserve its identity, and closing disposes it.

Monaco's editors and diffs consume the resolved profile palette and fonts,
including live preset changes and overrides. Monaco remains lazily loaded.

## Consequences

The user-requested browser design takes priority over released chrome while
retaining the existing sidebar schema, recursive bookmarks, session behavior,
and host-controlled theme. No new framework abstraction is introduced.
