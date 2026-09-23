# 0153: Downloads in the dock

- **Status:** Accepted
- **Date:** 2026-09-23
- **Builds on:** 0108 (open modes), 0150 (site settings)

## Context

A page that offered a file to download either asked for a save location
through the OS dialog or, once saved, gave no sign of where the file went.
There was no list of downloads, nothing to reopen or reveal, and nothing
showing progress. Chrome's model is the expectation: a download starts
without a question, a toolbar button shows progress and opens a bubble
with the recent files, and a Downloads page lists everything.

## Decision

**Downloads save without asking**, to the platform's downloads folder
(`CATAMORPHIC_DOWNLOADS_DIR` overrides it, for tests), under a name made
unique the way Chrome does ("report (1).pdf"). The main process keeps a
per-profile record (`profiles/<id>/downloads.json`) of every download:
size, progress, state, origin host, saved path. Windows of the profile
receive the list whenever it changes, throttled while bytes arrive.

**The dock carries the download button.** Chrome keeps it in the toolbar;
Work has no such toolbar, and the dock is where the app's own activity
lives, so the button sits beside the chat bubbles. It appears once
something has been downloaded, fills a ring while downloads run, marks a
finished download nobody has looked at, and opens a bubble with the last
few and a way to the page. In-flight downloads can be cancelled there.

**The Downloads page** (`kind: "downloads"`, reachable from the palette)
lists every download by day with filter, pause/resume/cancel while in
flight, Show in Finder and Remove from list otherwise, Open folder and
Clear finished. A row opens with the usual open gestures (ADR 0108).

**Opening a file means opening it in Work when Work can show it**: files a
browser tab renders (`isBrowserFile`: PDF, images, video, audio, HTML) and
plain text open as a `file://` browser tab; anything else, and anything
missing or unfinished, is revealed in the file manager instead of being
handed to whatever app the OS would pick.

## Consequences

- No save dialog: a page cannot ask where a file goes; users pick it up
  from the downloads folder or the Downloads page.
- The record is the app's, not the file system's: deleting a file leaves
  a "Deleted" row until it is removed.
- Downloads left in flight when the app quits are marked interrupted on
  the next launch; resuming across restarts is not attempted.
