# 0340 — The window renders what changed: workspaces in a store, parts that skip a render that is not theirs

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

ADR 0338 left the window rendering as one component per change. Every
workspace of a project lived in one `useState` of `App`
(`apps/desktop/src/renderer/app.tsx`, about 9,700 lines), and `App` gave
each child fresh closures and lists on every render, so a tab click, a page
title, a chat's signal or a sidebar's motion rendered the whole window: 366
components for a switch between two pages, 3,310 with 128 sleeping tabs.
A switch between two chats took ten commits and a switch from a page to a
chat twenty-two, the dock rendering every chat for one chat's news and each
chat's chips measuring themselves through a motion nobody saw
(`apps/desktop/docs/performance.md`). Measured, `App`'s own body was
cheap (about half a millisecond); the cost was what it made render.

## Decision

**Workspaces live in a store outside React** (`lib/workspace-store.ts`, a
jotai atom per project runtime). What changes them reads and writes the
store; a part of the window follows the slice it shows with
`useWorkspaces(store, select)`. A change applies at once and reaches its
followers in the caller's React batch, so it still commits together with a
`setState` made beside it. `App` follows every workspace for now.

**A part of the window renders when what it shows changes.** `App` stays
the place the window is composed, and the parts it draws are memoised
against it:

- Rows take their own entry. Lists `App` rebuilds keep their identities
  while nothing about an entry changed (`useStableEntries`), so the tab
  strip draws the two tabs a switch changed and the dock the chats it
  changed.
- Handlers stay the same for a part's life and run the latest closure
  (`useLatestHandlers`, `quiet`), as the palette's host already did. This
  is for handlers only: a function a part calls while it renders is given
  as its answer, or changes identity when its answer does.
- What is built for one moment is built then: a tab's menu when it opens,
  a signal's marks when one first shows.
- A source says what of the surface in front it lists from (`listsFrom`);
  a section reads again for that, not for every tab that comes forward.

Considered: moving every derivation out of `App` at once, so that `App`
follows nothing. Its 9,000 lines of closures read the workspace in several
hundred places and an end-to-end suite of 130 files holds its behaviour; in
one change that is a rewrite nobody could review. Memoising against it is
what removes the cost, and the store lets each derivation move to the part
that shows it, one at a time. Considered: `useSyncExternalStore`. A store
change would render in its own synchronous pass, apart from a `setState`
made in the same callback, and commit the window between the two.

## Consequences

- In the isolated test desktop, a switch between two pages with 128
  sleeping tabs renders 324 components in `App`'s commit where it rendered
  3,310, in 17 ms of script where it took 60; between two chats, 1,049
  components in 7 commits where it took 2,895 in 10 (28 ms against 48 to
  66); from a page to a chat, 1,020 in 6 commits where it took 2,292 in 22.
  A tab holds 18 elements where it held 45.
- A new child of `App` is expected to skip renders that are not its own:
  stable entries, handlers through `useLatestHandlers` or `quiet`, and no
  function called during its render unless its identity follows its answer.
- `App` still renders for every change and derives what its parts show.
  A sidebar section still renders once when the tab in front changes (the
  surface is a prop, not a slice it follows), and every row of a section
  that renders does. A chat coming forward still renders `App` twice, and
  the workspace is still saved whole after a switch. Each is a derivation
  to move behind a selector; none needs a new mechanism.
