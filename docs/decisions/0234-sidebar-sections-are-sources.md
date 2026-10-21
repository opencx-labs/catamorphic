# 0234 — A sidebar section is a source; Work's lists are sources like any other

> Rows gain `activity` beside `signal` ([ADR 0273](0273-a-chat-icon-says-what-it-is-doing-and-what-needs-you.md)): what a row is doing rides its icon's lower corner, so a chat can show it with what needs the person.

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [0132](0132-shared-contextual-sidebar-contributions.md), [0140](0140-local-agent-freedom-and-executable-sidebar-sources.md), [0147](0147-uniform-sidebar-sections.md), [0186](0186-palette-modes-and-use-ranked-search.md), [0226](0226-session-metadata-and-this-session.md)

## Context

ADR 0132 promised one implementation path for built-in and custom
sections, but the renderer still picked one of a dozen hand-written
components by `section.type`. Built-ins read Work's data, opened Work's
surfaces, owned verbs (`archive`, `pin`, `publish`, `new-chat`) and header
buttons a person's section could not have. Customizing a built-in meant
choosing among its presets, and every new built-in made the gap wider. The
default right sidebar (This session, Activity, Changes, Proposals) was the
largest such set, and nobody liked it.

## Decision

**A section shows rows from a source, static `items`, an `app` or a
`note`.** There is no `type`. A list section names its source:
`source: "work:chats"` for one of Work's lists, or a module path for code
in the project (`source: ".work/todos.ts"`). Presentation stays in the
layout: `title` (empty for none), `presentation: "tiles"`, `collapsed`,
`hideEmpty`, `empty`, `height`, `rowHeight`, `when`, `open`, `headerActions`,
`itemDefaults`, `itemOverrides`. Source options (`filter`, `sort`,
`groupBy`, `scope`, `pageSize`, `includeLatent`) are gone: a module that
wraps a source does that in a few lines.

**Work's lists are modules on the same contract.** `work:pinned`,
`work:bookmarks`, `work:library`, `work:workflows`, `work:apps`,
`work:chats`, `work:subsessions`, `work:activity`, `work:files`,
`work:tabs`, `work:remote`, `work:git`, `work:prs` and `work:session`
implement `load`, `subscribe`, `action`, `move`, `drop` (and optionally
`reveal`, a row for something in front that is not loaded yet). They run in
the window, sharing its caches; a person's module runs in its Bun process
(0140). One renderer draws every list, for both; nothing branches on a
source's name. Each `work:*` source declares only a default title and empty
sentence.

**A row opens its address.** Rows carry a workspace target (`url`): a
chat, `workflow:`, `app:`, `file:`, `run:`, a tab key, a page, or
`command:<id>` for one of Work's commands. One resolver opens all of them,
so the row is active when its target is in front, drags as that target,
and gets the inspector Work has for it (a chat's live details). A row whose
address is an open tab is that tab wherever it is listed: it drags as the
strip's tab does, and an agent points at it by tab key. A row
without one runs its source's `open` action, or opens its folder. Header
buttons are `headerActions` in the layout; "New chat" is
`url: "command:new-floating-chat"`, and its shortcut shows on its hint.

**Actions belong to sources.** The host keeps only the open modes,
`copy-url`, `refresh` and `search`; any other action name is the source's
(`run:` is gone). An action may ask the person for up to four text values
first (`input.fields`), and may return `{ open, mode }` for Work to open.
Rows grew what built-ins needed, so everyone has it: `signal` (working,
attention, unread), badges with icons, six preview facts, tiles, drop
targets that appear while something they accept is dragged, and animated
labels.

**A module reaches Work and anything else through what already guards
it.** Its section's `collections` grant names the Work lists it may read
and act on (`work.read`, `work.execute`): the same grant app widgets use.
A section that read a list reads again when that list changes, so a module
that sorts `work:tabs` (working chats first) follows live, and rows keep their
identity, so one that changes place slides there.
`workflows` names project workflows it may call (`work.call`), which is
how a source reaches secrets, the gateway and brokered connections: the
workflow runs under the existing run authorization, secrets and audit,
and the module never holds them. Otherwise a module is local code with
the project's own authority (0140), Work's Bun first on its `PATH`. It is
still refused in connected projects. Calls to Work are answered only for a
request the module's own runtime is serving, eight at a time, and the wait
does not count against the request's budget. What any source returns is
bounded, and may open only commands that open something (a layout may name
any). A `workspace.js` is evaluated with nothing of the main process in its
context, and only its JSON value leaves it.

**The right sidebar is empty by default.** Its screens (This session,
Activity, Subsessions, Changes, Proposals) are removed; their data stays as
`work:session`, `work:activity`, `work:subsessions`, `work:git` and
`work:prs`, and Find changed files searches `work:git` in the palette.

**Tabs in the sidebar are a section; chats are tabs.** The default left
sidebar has no chats list: chats open as tabs, and the palette finds every
chat. With tabs placed in the sidebar (a setting), the default Tabs section
lists `work:tabs` (`when: { tabPlacement: "sidebar" }`), chats among them with
their signals, a chat's opened tabs nested under it, drag to reorder; the tab
strip has no vertical form of its own any more. Tabs leave the top bar only
while a sidebar section lists them (`work:tabs`, or a module granted tabs).

**Existing layouts are rewritten once.** A profile's `workspace.js` and its
per-project overrides are converted on first load and the original is kept
beside them (`workspace.js.v1`); sections whose screens were removed are
dropped, and a Tabs section becomes `work:tabs` shown while tabs are placed
in the sidebar. A project's committed `.work/workspace.js` is never rewritten: it
loads with an error naming the change until someone edits it.

Considered: keeping `type` as a preset name over sources (the special path
this removes); running Work's lists in Bun processes (slower, and they
would lose the window's caches); giving modules the embedded server's
address (builder authority over every profile, past every grant); handing
modules secrets or gateway grants directly (a new authorization path,
outside the audit and masking runs already have).

## Consequences

A person's section can do anything a built-in does, and a change to a
`work:*` source reaches every layout that lists it. Agents learn one
section shape. The renderer loses its per-type components, a dozen
settings and verbs, and the code that only right-sidebar screens used.
Chats, bookmarks and the Server section look slightly different where
their bespoke chrome became generic rows. Pull requests a chat records are
listed only by a section that shows `work:session`.
