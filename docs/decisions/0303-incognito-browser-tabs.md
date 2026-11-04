# 0303 - Incognito browser tabs

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Every browser tab lived in its profile's persistent session
(`persist:profile-<id>`): cookies and sign-ins survive restarts, and every page
reaches history, site icons and the downloads list. People also want a page
that leaves nothing behind, as Chrome's incognito window does. Incognito chats
(0062) already use the word for "stays on this machine"; a browser tab needs
the stronger Chrome meaning.

## Decision

An incognito tab is an ordinary browser tab whose entry carries `incognito`.
Its page runs in the profile's incognito session, an in-memory partition
(`incognito-profile-<id>`, no `persist:` prefix) shared by all of the profile's
incognito tabs, as Chrome's incognito windows share one session. Main prepares
it like the profile's session (Chrome identity, permission prompts, the share
picker, downloads) and admits a guest to it only for that window's profile.

Five seconds after its last page (tab or sign-in popup) is gone, main clears
its storage, cache and HTTP authentication. The delay lets a tab replace its
page, as recovery or a project moving windows does, without signing out.

What it leaves out, as Chrome does by default: no history, retitles or site
icons; no extensions (not loaded, not told of the tab); no permission choice
remembered; no restore after relaunch. Workspace snapshots drop incognito tabs
and closed-tab records except while a project moves windows. Incognito tabs
never sleep, since a page unloaded after the session ended would wake signed
out. Downloads save as usual, but their records stay in memory and leave the
list when the session ends. What an incognito page opens (links to new tabs,
popups, Alt-click previews, its menu) stays incognito. Opening a link from any
other tab never switches into an incognito one. Bookmarks, saved passwords
and history suggestions remain usable, as in Chrome.

Opening: palette "New incognito tab" (Cmd+Shift+N, Chrome's binding) and a
page's "Open link in incognito tab". A Ghost on the tab's icon and an
Incognito pill in its toolbar mark it.

Rejected: one session per tab (breaks sign-ins spanning tabs and popups);
gating on `allowIncognito` (0062's policy concerns chat mirroring; pages are
never mirrored).

## Consequences

The project policy keeps its chat-only meaning. Agents can still see and
drive an incognito tab the person opened, as any other tab. A future
"extensions allowed in incognito" toggle would prepare extensions into the
incognito session and report its tabs.
