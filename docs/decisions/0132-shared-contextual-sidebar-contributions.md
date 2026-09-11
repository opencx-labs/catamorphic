# 0132: Shared contextual sidebar contributions

- **Status:** Accepted
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
