# 0249 — A window coming back reads only what it missed

- **Status:** Accepted (refines [0229](0229-idle-pollers-wait-for-hints.md))
- **Date:** 2026-10-18

## Context

Coming back to a Work window, from another app or another Work window,
stuttered, most of all after a while away. Every open project's
workspace stays mounted, and two things fired for all of them as the
window came back. TanStack Query refetched every stale query on window
focus (its default; the desktop's caches are stale after 30 s), so each
reader rendered twice: fetching, then fetched. The chat lists also read
every loaded page of every project's list again, on focus and on being
shown, whether or not anything had changed. Measured in a dev window
with production backgrounding, a return after 45 s cost about 183 ms of
render work and 7 requests.

## Decision

**Hints and polls keep a window current, so focus reads nothing by
itself.** The desktop's query caches (`lib/query-client.ts`: the window's
own and each remote project's) turn `refetchOnWindowFocus` off. A query
whose data can change outside Work with no hint opts back in: a pull
request's state, the file an editor tab shows from disk (unless a draft
holds it), and a pinned sidebar note.

**A hidden window catches up once, on what it dropped.** ADR 0229's chat
lists drop their wakeups while the window is hidden. They now remember
that one was dropped and read the loaded pages again once, as the window
shows; a window that missed nothing reads nothing, and regaining focus
alone never reads.

Considered: a longer `staleTime` (only delays the burst); refetching only
the visible workspace on focus (still a burst, and hidden workspaces
then show stale data when switched to, with no hint to correct it).

## Consequences

The same return costs about 21 ms of render work and 2 requests (the
catch-up a hidden window needed and the active chat's watchers). A new
query that reads something no hint covers must opt into focus refetch,
or poll. A file changed outside Work still has no hint while the window
stays in front; it shows on the next return or an agent's change.
