# 0318: Pinned tabs

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

People keep a few tabs open all day (a mail page, a chat, a shell) and lose
them to Cmd+W, Close all tabs, or a long strip. Work already has pinned pages
(ADR 0116): profile-wide bookmark tiles in the sidebar, web pages only. Those
are shortcuts to open something, not a way to keep an open tab of any kind.

## Decision

Any tab except a New Tab can be pinned from its right-click menu, in the strip
or the sidebar's Tabs section, as in Chrome. The workspace records
`pinnedTabKeys`; `orderedTabKeys` puts pinned tabs first, in `tabOrder`'s
order, so the strip, keyboard cycling and `work:tabs` agree. A pin goes last
among the pinned; an unpin goes first among the rest. Dragging cannot mix the
two runs.

A pinned tab shows only its icon (its hover card names it) and has no close
button. Cmd+W leaves it, as Arc does; Close tab in its menu closes it. With
tabs pinned, Close all tabs reads Close unpinned tabs and leaves them.

Pinning moves a tab, so it does not jump: a copy of the tab collapses where it
stood, as a closed tab does, and the tab then grows in among the pins as its
icon. Unpinning plays the same pair the other way.

A pinned tab stands on its own: pinning a tab under a chat takes it out of the
chat first, unless an agent holds it there, and attaching a pinned tab to a
chat unpins it. A pinned chat keeps its group after it. A closed tab loses its
pin, so a tab opened later under the same key (Settings, a workflow) starts
unpinned; a chat floating out of the strip keeps it.

Pins are saved with the workspace and come back after a restart. A pinned
shell of the person's own comes back as a fresh shell; agent and remote
terminals, and chats never sent, still do not survive a restart.

Reusing pinned pages for this was rejected: they hold only web pages, are
shared across projects, and open a page rather than keep a tab.

## Consequences

`work:tabs` rows carry `data.pinned`, so a module can group pinned tabs, and a
pinned row offers no hover close. Pinned pages and pinned tabs are separate
features with similar names; the menus say "Pin tab" or "Pin chat" for one and
"Pin across projects" for the other.
