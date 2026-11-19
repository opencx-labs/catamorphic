# 0338 — What is out of sight is data: sleeping tabs mount nothing, and a chat without a stream reads what it missed

- **Status:** Accepted (amends [0194](0194-browser-tabs-load-like-chrome-and-sleep-when-unused.md) and [0197](0197-agent-sessions-are-an-event-log-of-turns.md); refines [0229](0229-idle-pollers-wait-for-hints.md) and [0249](0249-a-window-coming-back-reads-only-what-it-missed.md))
- **Date:** 2026-11-19

## Context

A person with three windows, 138 tabs (127 asleep) and five open chats saw
lag and freezes, most of all when switching tabs and chats. Sampled from
outside the installed app while agents worked, the front window's main
thread was fully busy for 200 to 400 ms several times every 30 seconds, a
covered window did the same at the same instants, and the main process
used 11 to 23% of a core. Four things paid for what nobody could see
(`apps/desktop/docs/performance.md`):

- A sleeping tab lost only its `<webview>`. Its whole browser screen stayed
  mounted (toolbar, menus, dialogs, six IPC listeners), and every change of
  window state rendered all of them.
- Each window mounted a chat for every chat of every window in the profile.
  One that another window owns, in a project this window does not show, can
  never appear there, yet it loaded the conversation and followed its turn.
- A chat without a stream (behind another tab, minimised, or past the four
  stream slots) read its whole snapshot again every 1.5 s while anything was
  unsettled: 57 to 117 ms of the main thread per read for a 3 MB
  conversation. `performance.md` already named this the next target.
- A covered window read its chat lists again for every hint.

## Decision

**A sleeping tab is data, not a screen.** The workspace mounts a browser
screen only for a tab that is awake. `useTabSleep` owns the whole sleep: it
asks what keeps the page awake, has main keep the page's state through the
tab's guest, then marks the tab asleep, and holds the snapshot's id for the
wake (released if the tab closes in its sleep, or its address changes). A
waking tab mounts a fresh screen that resumes from that snapshot or from
the tab's saved history, with no opening to wait out.

**The dock mounts a chat only where it can show:** this window's own
chats, and those of the project it shows (every project's, for a
multi-project or detached dock).

**A reader without a stream reads the events it missed.**
`GET …/sessions/:sessionId/events/missed?after=<sequence>` answers once with
the messages a stream opens with: the events since, or a `reset` carrying a
fresh snapshot when they are too many to replay. `@catamorphic/react` follows
a session this way wherever it polled the snapshot. The snapshot is read
for the first load, a gap, and a retry after a failure. A server that
predates the read answers 404 and is asked for the snapshot, so older
servers keep working.

**A hidden window drops chat-list hints** and reads once as it shows again,
as its sidebar lists already did (ADR 0249).

Considered: one multiplexed event stream per window, which would remove the
slot limit and every poll. It needs a session store whose hidden readers
fold events without rendering, a larger change recorded as follow-up.
Memoising the browser screen instead of unmounting it would keep 128
components, their effects and their listeners.

## Consequences

- In the isolated test desktop, 128 sleeping tabs cost a tab switch 30 ms
  of script against 43 ms, and the window 11,269 DOM nodes and 1,125
  listeners against 15,446 and 1,972. A long chat working behind another
  tab stalled the main thread once in 16 s (42 ms) against nine times
  (223 ms). Other windows' chats and covered windows now cost nothing; that
  was not measured in isolation.
- A tab asleep keeps no screen state: its find query and an address half
  typed are gone when it wakes. Its page state, history and place are kept
  as before.
- `events/missed` is public API. Hosts with their own clients may use it to
  follow a session without holding a connection.
- Still mounted while hidden: awake tabs, this window's own chats, editors
  and terminals. The window still renders as one component per change.
