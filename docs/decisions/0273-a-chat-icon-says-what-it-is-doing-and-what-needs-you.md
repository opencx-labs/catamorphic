# 0273 — A chat's icon says what it is doing and what needs you, at once

- **Status:** Accepted (amends 0234's row `signal`)
- **Date:** 2026-10-21

## Context

A chat's icon (its tab, its bubble, its row in the sidebar's Tabs) carried
one mark on one corner: the working spinner, or else a badge (a question,
a dot for attention or an unread reply, a pencil for a draft). A reply
that landed while the person was away lost its dot as soon as the agent
worked again, and a chat resting while a watch, its subagents or a
background command ran looked like one with nothing going on.

## Decision

**Two corners, one mark each.** The upper corner says what needs the
person: question, attention, unread, draft, in that order, shown whether
or not the agent works. The lower corner says what the chat is doing: the
working spinner (held back while a question waits), or, while it is not
working, what it left running and waits on: an eye for a command watch, a
bot for subagents at work, a terminal for a background command, in that
order. One glyph per corner
keeps a 14px icon legible; the transcript already uses these glyphs for
the same tasks. A custom chat icon's chat marker gives the lower corner
up while the chat says anything there.

Each chat reports `waiting` with its other live signals (`ChatLiveSignals`),
so tabs, bubbles and the folded bubble agree.

**Rows gain `activity`.** A sidebar row or chip may set `activity`
(`working`, `watch`, `subagent`, `command`) for its icon's lower corner;
without it, a `working` signal spins there as before, so existing modules
keep working. `signal` stays one value for sorting. Work's Tabs rows now
rank what needs the person first (attention, unread, then working) and
say what they are doing in `activity` and `data.waiting`.

Rejected: both the spinner and the waiting glyph at once (three marks on
a 14px icon); badges beside the title instead of on the icon (the strip
would shift as they come and go); splitting `signal` into two fields
(every module that sorts by it would break).

## Consequences

- A module ranking tabs by `signal === "working"` sees a working chat with
  an unread reply as unread; the documented example ranks by `activity`.
- The folded bubble's chat count moves to its lower-left corner.
- Followed sessions and session timers are not yet waits the icon shows,
  and the Chats list's rows set no `activity` yet.
