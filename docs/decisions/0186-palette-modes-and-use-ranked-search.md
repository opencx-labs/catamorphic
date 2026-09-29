# 0186 — Palette modes share one shape, and search ranks by use

- **Status:** Accepted
- **Date:** 2026-09-29
- **Refines:** 0052 (skills as commands), 0140 (executable sidebar sources), 0147 (uniform sidebar sections), 0154 (profile history)

## Context

The palette ranked by text alone: four literal buckets (exact, prefix,
contains, keyword), ties in list order, and fuzzy matches only when nothing
matched literally. Up to 80 history pages shared those buckets with the app's
own commands, so volume won. Any keyword hit scored like any other, so the
focused site's "Site settings" row, which carried the host as a keyword,
topped every query that matched the host. History already counted visits but
the palette ignored the counts; commands and surfaces were not counted at all.
Modes came in three unrelated shapes (chip modes, pickers, sidebar searches)
branched through one large results function, so a new mode touched five
places and users could not add one.

## Decision

**One mode shape.** A palette mode is a chip, typed names, and a row source:
`list` rows the palette ranks, `compute` rows the mode answers itself (input
and model choices), or `load` rows fetched once per entry and ranked, or per
query with the source searching (`filtered`). Built-in modes (history, files,
content, settings, sites, commands, web, agent), choice pickers (model,
effort, permission mode, agents) and sidebar searches all take this shape;
one loader owns debounce, abort, loading, empty, error and retry rows.
Committing a row either proceeds normally, stays (enter a mode, retry), or
answers the mode's question and puts the palette away.

**Custom modes are sidebar sources, in one workspace file.** The layered
`sidebar.js` becomes `workspace.js`, exporting `{ sidebars: { left, right },
palette: { modes } }` (profile, `.work/workspace.js`, personal override); no
other keys. Modes are validated with the sidebars. A mode takes exactly one row source:
an executable module (ADR 0140's contract), a custom section by id, or static
items. `search: "source"` passes the typed query to the module's `load`;
`topLevel` ranks a palette-searched mode's rows in the ordinary palette.
Mode ids share the section namespace, so main resolves either to its module.
Triggers cannot shadow built-in names, which live in `shared/palette.ts`.
Rows gain optional `keywords`. No new source type, runtime or DSL.

**Ranking is match × kind × use, plus learned picks.** The text match is
continuous: label above keywords above detail, word starts above substrings,
fuzzy as a scarce fallback. Each row carries a category prior (commands and
surfaces 1, project resources 0.9, settings and bookmarks 0.8, pages 0.6), so
a page beats a command only with a clearly better match or much heavier use.
Frecency (Firefox-style visit count weighted by sampled recency) multiplies
the score, with a small boost for use in the current project. A pick records
the typed query; rows picked for a related query rise strongly next time.

**Counts come from where visits happen.** Pages and project resources keep
their counts in history (their usage key is the history identity). Surfaces
count a visit whenever they come to the front, from any entry point.
Commands, settings, skills and sites count palette picks only, so a shortcut
used hundreds of times never floods the empty palette. A per-profile
`palette-usage.json` in main holds those counts and the learned picks;
clearing history clears it, removing a history entry forgets it.

**The empty palette leads with use.** Starting actions and the focused
site's settings stay first, then up to six "Frequent" rows (at most three
pages), then the usual commands and destinations. Individual site settings
leave the top level for the Sites mode; the host moves to the row's detail.

**One data layer for workspace lists.** The collection sources app widgets
already read (chats, subsessions, activity, files, workflows, apps, git,
PRs, bookmarks, remote, tabs) become the workspace sources: one registry,
created once and provided to the app. Widgets get it through their grants;
the palette lists its resources from it; every list section is searchable
through it with its own filter and sort (sections with view state, the
selected checkout and the review filter, search what they show); custom
modes may name a workspace source with a filter. Rows carry the fields
filters compare. Built-in sections keep their specialized renderers (tiles,
checkout groups) and share the registry's query caches, so a list loads one
way and refreshes everywhere.

**The palette is a module, not a component.** `renderer/palette/` holds the
host context (what the app provides, once, instead of 40 props), row hooks
(commands, surfaces, resources, history, settings), one file per built-in
mode, the loader and the ranker; `CommandPalette` is the shell that composes
them. Action icons are Lucide names in the shared action registry, like rows
in `workspace.js`.

## Consequences

- A new built-in mode is one file in `renderer/palette/modes/` plus its line
  in the mode index and its typed names in `BUILTIN_PALETTE_TRIGGERS` (which
  main uses to refuse colliding custom names); a mode declares the surface it
  highlights. A user's agent adds a mode by
  editing `workspace.js`, and one module can back a section and a mode.
- Ranking adapts to each person without configuration; there is no ranking
  knob, and the skill says so.
- Typed queries are stored per profile, bounded to 500, and cleared with
  history.
- New Tab starters stay in `.work/project.json`: core serves them to every
  client (the PWA included), and a server must never execute project code to
  render a list.
- Existing `sidebar.js` files are not read; move their contents under
  `sidebars` in `workspace.js` (ask the assistant).
