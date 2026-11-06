# 0155: Onboarding is a workspace tab; theme selection has one picker

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The empty-profile welcome and automatic agent setup present separate introductions.
Theme selection is buried in Settings. New users need a short tour that feels like
the workspace and lets them leave to work with an agent without losing their place.

## Decision

Use the existing workspace tab model for a closable, restorable Onboarding tab.
Open it under the former empty-profile and agent-less-project conditions, with
project load errors retaining their retry surface. Closing it skips automatic
presentation for that profile in the current session. The palette reopens it via
Onboarding, Tutorial, Welcome, Tour, Getting started, Learn, Guide, and Help.

Begin with Welcome, Theme, and Palette, followed by one Browser setup step for
import and default browser, then the existing starting choices. Use actual presentational
components with inert example data, no images, and the existing motion contract.
Keep the step on the tab, including when changing to a customization chat.
Done closes onboarding and opens an ordinary New Tab palette, preserving other tabs.
A first launch opens maximized with both sidebars collapsed. Later launches
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
