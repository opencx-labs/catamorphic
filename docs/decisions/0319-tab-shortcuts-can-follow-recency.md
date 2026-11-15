# 0319: Tab shortcuts can follow recency

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

Next tab and Previous tab walk the strip, left to right. People coming from
Arc or Dia bind them to Ctrl+Tab and expect the other common order: the tab
they looked at last, then the one before it. The workspace already keeps that
order (`recentTabKeys`, the tabs the person left, which decides the tab in
front after a close), so nothing new has to be tracked.

## Decision

A profile setting, `tabSwitchOrder`, chooses what the two shortcuts go
through: `strip` (the default, unchanged) or `recent`.

With `recent`, a press starts a pass over the shown tabs: the one in front,
the tabs left newest first, then tabs never visited in strip order
(`recentTabOrder`). The order is fixed for the pass. Each press moves one
step, Next toward older tabs and Previous back, wrapping. The pass lasts
while the modifiers of the shortcut that started it stay down; releasing one
settles it: the tab it ended on becomes the newest and the tabs passed on the
way keep the order they had, so one press always returns to the last tab and
two presses reach the one before it. A pass also settles when the window
loses focus or a key is pressed without the modifier, and ends when another
tab comes to the front by any other means. A shortcut with no modifier, and the palette's
commands, make each press its own pass.

A page keeps its key events, so the main process forwards a modifier's
release inside a page to the window (`catamorphic:browser-guest-key-up`), as
it forwards the shortcut's key.

The pass shows the tabs themselves; there is no switcher overlay. The strip
already marks the tab in front, and an overlay can be added on the same pass
without changing its order.

A source that sorts the sidebar's Tabs list was rejected as the way to do
this: it orders a list, and the shortcuts would still need the hold and
release.

## Consequences

- Tabs passed during a hold come to the front briefly; a sleeping page among
  them wakes.
- A new way to bring a tab forward needs no change: the pass ends when the
  tab in front is not the one it chose.
