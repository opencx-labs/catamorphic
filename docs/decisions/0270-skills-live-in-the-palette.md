# 0270 — Skills live in the palette: "/" opens them from a chat, Enter applies one here, ⌘↵ in a new chat

- **Status:** Accepted
- **Date:** 2026-10-20
- **Supersedes:** the composer `/` menu in 0052's "Renderer surfaces"
- **Builds on:** 0052 (skills as commands), 0186 (palette modes)

## Context

Skills had two launchers with two grammars. The composer's `/` menu
(`slash-menu.tsx`) listed shared skills, Work's status and the chat
agent's own commands, and a sent `/name args` was resolved into the
invocation even with the menu closed. The palette listed shared skills
among everything else in its empty state, and sent them to the focused
chat whatever the modifier. Two catalogs, two rankings, two keyboard
contracts, and a composer that rewrote what the person typed.

## Decision

**Skills are a palette mode.** `skills` is a built-in mode
(`palette/modes/skills.tsx`, trigger `skills`, and `/` as the first
character of the palette's input). Its rows are Work's Status for the chat
in front, the shared skills its agent may use (0056), and the agent's own
commands and skills, read fresh in the chat's checkout as the menu read
them. The empty mode leads with the most used rows under Recent. The
palette's empty state lists one Skills row instead of every skill; typing
still finds skills there.

**`/` in a composer with no prose opens it.** The slash is not typed; the
palette opens aimed at that chat (bringing its window forward when the
chat is in the detached dock). Pills in the composer stay and go with the
skill. Closing without a skill hands the typing back: Escape returns `/`
and whatever followed, so a message can start with a slash; Backspace on
the empty mode returns to an empty composer. A sent message is sent as
written: nothing resolves `/name args` any more, and harnesses that read
native commands (`/compact`) still do.

**Enter applies here, ⌘↵ in a new chat.** Enter sends the invocation into
the chat in front (or starts a floating chat when there is none); ⌘↵
starts a chat in a tab, ⌥↵ a floating one. An agent's own command in a
new chat runs on that agent. Status runs here only. A palette tab is
consumed by the chat it starts, as everything it opens does.

**Instructions are a second chip.** Tab on a row, or Space after typing a
row's full name, enters `skill:<name>`, whose input is the instructions:
`/review the auth change ↵` typed blind still works. Its placeholder is the
skill's `argument-hint` frontmatter, read by core (Claude Code's spelling),
returned by `GET /projects/:id/skills` as `argumentHint`. Backspace on the
empty instructions returns to the list.

**A sent skill reads as one.** The registry timeline takes
`presentUserMessage`, a host hook that leads the person's message with an
element of its own; the desktop leads a recognized invocation with a skill
chip and shows only what came with it.

Rejected: keeping the composer menu beside the palette mode (the two
grammars this removes); typing the skill as a pill into the composer
(two Enters for a skill without instructions, and a new pill kind);
resolving typed slash text on send (the composer rewriting the person's
words, and the catalog loading in every chat).

## Consequences

- One catalog, one ranking (frecency, learned picks) and one keyboard
  contract for skills, reachable from any chat, the palette and a New Tab.
- The composer no longer loads skill catalogs or harness commands, and a
  pasted or recalled `/name` goes out unchanged.
- `skills` is a reserved palette trigger; a workspace.js mode can no
  longer take it.
- Skill invocation control (`user-invocable`, `disable-model-invocation`),
  a place to browse and manage skills, background runs and several skills
  per message remain open.
