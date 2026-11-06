# 0132: Shared contextual sidebar contributions

- **Status:** Accepted. Local executable sources refine the execution boundary in [ADR 0140](0140-local-agent-freedom-and-executable-sidebar-sources.md). Amended by [0234](0234-sidebar-sections-are-sources.md): sections name sources, Work's lists are modules on the same contract, and the right sidebar's screens are gone.
- **Date:** 2026-09-11
- **Builds on:** 0081, 0090, 0102, 0107, 0123, 0126

## Context

Sidebar placement was configurable, but built-ins privately owned hierarchy,
actions, inspectors and subscriptions. Custom content could not reproduce them,
and sections could not express relevance to the current workspace surface.

## Decision

Built-ins and custom sections compose the same collection, tree, item, action,
section and tab primitives. Collections own stable identity, paged roots and lazy
children, snapshots, patches and shared subscriptions. Trees flatten expanded
branches for virtualization; focus, expansion and interaction state use item IDs.
Items expose icons, detail, badges, progress, inspectors and independently
configurable inline actions, overflow and right-click menus. Built-in sources
are reusable with filters, ordering, grouping and presentation overrides.

Authority filtering precedes contextual relevance. A single host-owned surface
context follows the active content, including floating surfaces and splits;
sidebar interaction retains that context. Loading, empty, error and unavailable
are distinct. Tabs derive availability from their sections without disposing
temporarily irrelevant widgets or conflating discovery with presentation.
Sources share listening and cache work; hidden views suspend expensive work while
lightweight availability updates can reveal them again.

Host React extensions and sandboxed project apps use the same public collection
and tree contracts. The existing app bridge conveys live surface context and
explicitly host-granted collection/action capabilities, with no renderer code
execution or ambient authority for project configuration. Apps may report their
content state. Desktop defaults and source adapters remain host doctrine.

Contextual Subsessions lists the current session's immediate children, including
latent children, without promoting them. This supersedes only ADR 0090's statement
that latent children appear exclusively on the parent rail; normal project Chats
still lists promoted sessions and archive semantics are unchanged.

## Consequences

There is one implementation path for built-ins and customizations. Changes are
breaking where needed; no legacy renderer or config merge layer is retained.
Agent guidance documents the real validated contract. Native visual verification,
large-tree/lifecycle tests and real Codex customization exercises verify parity.

## Amendment (2026-10-13): paginated collections load as they scroll

A long list (a project's chats) used to load its first 50 rows, end in a
"Load more" button, and re-read every loaded page on each poll. Now the
shared `Tree` loads a branch's next page itself once scrolling or keyboard
focus comes within a viewport of its end (`more: { load, loading, error }`
per branch), holds the end with still placeholder rows while it loads,
ends in an inline Retry when a page fails, and announces both politely. A
collection reports a page load (`paging`, `pageError`) apart from a
refresh, so the section header never spins for one, and can refresh from
the start only (`pages: "first"`) until the new rows meet the loaded ones.
The chats source starts at 30 rows, polls one page, re-reads the rest
every half minute or so, and always brings the open chat into the list.
