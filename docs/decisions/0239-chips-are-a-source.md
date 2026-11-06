# 0239 — A chat's chips are a source, and agents attach chips by metadata

- **Status:** Accepted (amended by [0277](0277-agents-reach-trusted-hosts-code-runs-confined-commands-run-as-approved.md): a chip's icon is a Lucide name, a data image, or an icon its site showed this profile)
- **Date:** 2026-10-17
- **Builds on:** [0226](0226-session-metadata-and-this-session.md) (session metadata), [0234](0234-sidebar-sections-are-sources.md) (sources)

## Context

The chips above a chat's composer were a closed list the desktop built by
hand: a `ChatSurface` type with a field per kind (`info`, `mcpApp`,
`removable`, `faviconUrl`), one look, a hard-coded group of three per kind,
and a strip that scrolled sideways once it filled. Nobody could add a chip, an
agent could not keep anything in view but a tab it opened, pull requests a chat
recorded showed only in a sidebar section nobody had, and chips sat on the
darkest surface token, so dark themes drew them black.

## Decision

**Chips are rows from a source, like a sidebar section's.** workspace.js
gains `chips: { source }`. `work:chips` (the default) is Work's own chips for
the chat; a module path names the project's code, which reads them with
`work.read({ source: "chips" })` and ranks, filters, groups, restyles or adds
to them, with its own actions in its `action`. One renderer draws every chip.
Order is rank; a group is a chip with `hasChildren` whose members name it as
`parentId`. Behavior is code, never a configuration language.

**A chip is the shared row, grown.** `wide` spans the composer's width (badges
and buttons in view); `tone` (accent, success, warning, danger, info) colors an
icon or a badge by what it says, and sidebar rows draw it too. Work's verbs
have their own label and icon, so `{ action: "open-side" }` is the open-to-the-
side button in a module's chip or an agent's. Work's `remove` (the X) closes a
tab the chat opened or takes a recorded pull request or an attached chip off
the chat, and `data.kind` says what each chip is.

**Work's chips** are the tabs the chat opened, its forks and subagents, the app
views its tools showed, the chips its agent attached, and the pull requests it
recorded as wide chips with their live state, size, comments and checks.
`CodeHost.pullRequestStatus` reads a pull request by its address with the
person's own connection; the GitHub CLI is the fallback. Compact chips come
first, wide ones stack under them; past three lines the rest fold behind "N
more"; nothing scrolls sideways. Folding, arriving, leaving, moving and a
changed icon all animate on the standard curve.

**Agents attach chips through session metadata**, as they record pull
requests: the key `chips` is a list of chips (`SESSION_CHIPS_CONTRACT`,
`sessionChips` in `@catamorphic/agent-protocol`). Data, not functions, so a
chip an agent makes on the fly needs no code: it opens its `url` and carries
Work's buttons; a module gives kinds of chips (`data.kind`) their behavior.

**Chips run beside their chat.** The dock that shows a chat publishes its
chips and answers its chips module's `work` calls in its own window (the
detached dock included), so a chips module reads only `chips`
(`collections: ["chips"]`) and calls workflows; main sends each module call's
session with it. Connected projects run no modules and show Work's chips.

Right-click on any chip offers Customize chips: a new chat with "Help me
customize my chat chips." waiting in its composer beside the layout file and
the chips contract. Cmd+J focuses the first chip (bringing a hidden chat
back, unfolding the rail until focus leaves); arrows move between chips and
lines, Tab between a chip's buttons, Escape back to the composer.

Considered: a chip type registry with renderers per type (a second row model
and a DSL); functions for the standard buttons (an agent's chip is JSON);
chips as a sidebar section shown elsewhere (they belong beside the composer,
in whichever window holds the chat); a dedicated attach tool (metadata already
syncs, mirrors and bounds what agents keep on a chat).

## Consequences

Agents keep anything in view with one metadata write, and a person's agent can
reshape every chat's chips in a few lines of code. `ChatSurface` is gone; the
workspace hands the dock chips. A chips module cannot read Work's other lists.
A chat's chips count against its 32 metadata keys only through the one `chips`
key, and against the value bound (16 KB) as a list.
