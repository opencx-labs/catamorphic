# 0155: Onboarding is a workspace tab; theme selection has one picker

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The empty-profile welcome and automatic agent setup present separate introductions.
Theme selection is buried in Settings. New users need a short tour that feels like
the workspace and lets them leave to work with an agent without losing their place.

## Decision

Use the existing workspace tab model for a closable, restorable Tutorial tab.
Open it under the former empty-profile and agent-less-project conditions, with
project load errors retaining their retry surface. Closing it skips automatic
presentation for that profile in the current session. The palette reopens it via
Tutorial, Onboarding, Welcome, Tour, Getting started, Learn, Guide, and Help.
Tutorial is the user-facing name in the tab, palette, and return hint.

Begin with Welcome, Theme, AI agents, The dock, Keyboard shortcuts, Palette,
and Browser setup for import and default browser. Agent configuration opens the
existing wizard as a modal and retains the tutorial; its action shows completion
when configured. The dock starts collapsed on the right, and its tutorial uses
the real bubble strip with an animated cursor. Project creation and server
connections remain in the project switcher. Use actual presentational
components with inert example data, no images, and the existing motion contract.
Keep the step on the tab, including when changing to a customization chat.
Place later/return reminders above the navigation in a shared footer.
Done closes onboarding and opens an ordinary New Tab palette, preserving other tabs.
A first launch opens maximized in a real Default Project with onboarding selected,
both sidebars collapsed, and the dock already visible and collapsed on the right.
The default right sidebar contains only the agent customization button; Activity,
Proposals, and other widgets are opt-in through sidebar configuration.
The default-project operation reuses the profile's project and coalesces concurrent
startup requests, with the boot veil waiting for its workspace. Later launches
restore saved placement and sidebar choices.

Theme selection uses one modal from onboarding, Settings, and the palette. Keep
sparse profile/project/personal theme storage and advanced color/font editing.
The advanced controls use the shared disclosure motion; the dialog follows content
size with bounded height interpolation and respects reduced motion.
Color tokens interpolate over the existing 200ms motion contract. A theme request
opens existing agent setup in a separate tab if needed, then a normal chat. The
tutorial remains open at the same step; no new agent setup model is introduced.

## Consequences

Setup actions retain their existing implementations and can be skipped. Existing
users can revisit the tour. Preview data cannot create projects, send messages,
open pages, or mutate workspace state. Agent creation never dismisses the tutorial.
