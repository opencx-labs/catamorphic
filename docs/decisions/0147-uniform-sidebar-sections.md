# ADR 0147: Uniform sidebar sections

- Status: Accepted
- Date: 2026-09-18
- Supersedes parts of: [ADR 0116](0116-bookmark-library-and-pins.md) (private
  bookmark drop zones), [ADR 0132](0132-shared-contextual-sidebar-contributions.md)
  (per-section status rendering)

## Context

Every sidebar section reported its content state through one protocol
(ADR 0132) but drew loading, empty and error states itself: four sections
rendered nothing while loading, the rest each invented a sentence, and only the
executable-source section had a spinner, retained rows during refresh and a
Retry. Drag and drop had no model at all: bookmarks carried a private
`data-bookmark-drop` grammar with string-typed targets, half of which had no
visual feedback; workspace tabs had their own reorder; nothing could be
reordered inside a section; and a `sidebar.js` section could not accept a drop.

The product goal is that a sidebar an agent writes looks and behaves like a
built-in one without effort from the agent or the user, and that the
primitives are flexible enough to customize anything without breaking the
chrome.

## Decision

**One status language, owned by the chrome.** A section reports
`{state, refreshing, error, retry, empty}` and renders rows only. The section
chrome draws: a header spinner while loading or refreshing; three still
skeleton rows before the first result; one muted sentence when empty, which
`section.empty` in `sidebar.js` replaces; the error with Retry when a read
fails. Rows stay on screen during a refresh, and collapsing a section never
discards what it loaded. Built-in sections that showed nothing while loading
(Changes, Proposals, Server, Bookmarks) now follow this; Changes keeps its
last overview across collapse and re-expands instantly.

**One drag-and-drop model, owned by the shared tree.** `Tree` and
`CollectionTree` in `@catamorphic/app` accept `dragAndDrop = {drag, accept,
onDrop}` and own pointer math (outer quarters of a row are sibling slots, the
middle is "inside" for rows with children, the space past the last row is the
root), the accent insertion line and the accent outline on the future parent.
Sections declare policy only. The desktop's payload is one MIME type,
`application/x-catamorphic-sidebar-item`, carrying section, scope, id, parent,
kind and url, beside the existing tab payload so rows with a link still drop
into bookmarks and chats.

**The same contract for custom and built-in sections.** An executable source
exports `move({itemId, parentId, beforeId})` to make its rows reorderable and
reparentable, and `drop({parentId, beforeId, payload})` to accept pages,
chats, bookmarks and other sections' rows. The worker reports which handlers
exist with every page, so the tree only accepts drags a source can honor.
Bookmarks implement the same contract over their store: `move` reorders and
reparents within a scope, and placement takes `beforeId`. There is no
bookmark-specific drop code left in the renderer.

**Headers.** Title, then the section's declared actions, then the disclosure
chevron at the far edge. Nothing in a header appears only on hover; a refresh
control is an explicit `headerActions` entry. The tab panel reserves its
scrollbar gutter so expanding a section never narrows the others.

## Consequences

- Section components lose their loading, empty and error markup; new sections
  cannot ship a private status presentation.
- `sidebar.js` gains `section.empty`; executable sources gain `move` and
  `drop`; the request schema gains `beforeId` and `payload`.
- The bookmarks store gains `move`; `place` accepts `beforeId`; ordering is
  the array order within a parent, folders before bookmarks.
- Tests drive drops through the tree rows (`data-tree-id`) and drop zones
  (`data-drop-zone`) at pointer positions, the way a user would.
