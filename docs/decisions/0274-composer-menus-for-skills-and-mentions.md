# 0274 — The composer's "/" and "@" menus: skills and mentions go in the message as pills

- **Status:** Accepted
- **Date:** 2026-10-21
- **Supersedes:** 0270's "`/` in a composer with no prose opens the palette" and "a sent message is sent as written" for composer skills
- **Builds on:** 0052 (skills as commands), 0186 (palette ranking), 0270 (the palette's Skills mode), 0123 (resource links)

## Context

0270 made `/` in an empty composer open the full Cmd+P palette, centered,
with its own input. It had one catalog and one ranking, but it took the
person out of the message: `/` worked only before any prose, so "fix it and
/" did nothing, and the palette's header, two-line rows and key-hint
footer were heavy beside the composer. Nothing in the composer mentioned a
folder, a tab, a chat, a workflow or an app; pills came only from pasting
and dragging.

## Decision

**A composer has two menus, opened by the word the caret ends.** `/` or
`@` at the start of any word (start of the message, or after a space)
opens a compact list right above the composer; typing goes on in the
composer and filters it. A second `/` or `@` in the word (`src/lib`,
`me@host`) is a path or an address, not a menu. ↑/↓ move, Enter or Tab
picks, Escape closes the menu for that word and keeps what was typed, and
the next word opens it again. Rows are one line: icon, name, muted
description, a chevron when the row opens a picker. No header or footer.

**`/` lists the chat's commands and the skills.** Status, Agent ›, Model ›,
Effort ›, Permissions ›, Fork chat and Archive chat run at once (the
chevron ones open the palette's existing pickers, aimed at the chat) and
take their word away. Shared skills the chat's agent may use, and its
harness's own skills, become a **skill pill** where the word was, so a
skill sits inside the message ("fix the login bug and ⟨Code review⟩").
Space after a skill's whole name does the same, so `/review the auth
change ↵` typed blind still works. A harness's own commands (`/compact`)
are listed only when `/` starts an otherwise empty message; Enter sends
them as written, Tab keeps them for arguments.

**`@` mentions what the message points at.** Open tabs (from the same
overview the agent reads), files and folders of the chat's checkout
(Git-visible, or a bounded walk of a folder without Git), chats, workflows
and apps. Each becomes the pill the composer already knows: a `tab` pill, a
`path` pill (a folder's path ends in `/`), or a `url` pill holding the
workspace link (`session:<id>`, `workflow:<name>`, `app:<name>`).

**The skill pill is a text attachment source.** `{ type: "skill", name,
path? }` joins the attachment schema; every harness reads it as
`Skill "<name>": use it for this message` (with the file for a harness's
own skill). Folder paths and workspace links get descriptions of their own.

**One ranking.** Both menus rank with the palette's index and its use
signals, under the palette's usage keys (`skill:<name>`, `action:<id>`),
so a skill picked in either place leads in both. The palette's Skills mode
stays as 0270 describes it, reached by Cmd+P then `/`, and still sends its
invocation sentence.

Rejected: a skill as a chip outside the message (one per message, and not
where the person put it); keeping the palette as `/`'s surface with a
compact skin (the input still leaves the composer, and `/` mid-message
still has nowhere to go); grouping the `/` list by kind (Codex's single
alphabetical list reads faster at this size).

## Consequences

- `/` and `@` work anywhere in a message, in a chat's tab, its floating
  dock and the detached dock window, without the palette.
- Several skills can share one message, each where it was put.
- Picking a skill without instructions is two Enters: one picks, one sends.
- The composer no longer hands typing back from the palette: `openSkills`,
  the `resume` dock action and the palette's `composer` request field are
  gone.
- The attachment schema grew a member: the API spec and client are
  regenerated, and any client drawing pills should give it an icon.
