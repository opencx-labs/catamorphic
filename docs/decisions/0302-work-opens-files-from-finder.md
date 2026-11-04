# 0302 - Work opens files from Finder

- **Status:** Accepted
- **Date:** 2026-11-03
- **Extends:** 0153 (downloads in the dock)

## Context

Work shows PDFs, images, video, audio and web pages in a tab, edits text and
code in its editor, and opens a download that way (ADR 0153). From Finder
there was no way in: Work did not appear under Open With, and a file dropped
on its Dock icon was refused.

## Decision

**Work declares the files it opens.** The macOS build registers document
types (`mac.fileAssociations`) for exactly `BROWSER_FILE_TYPES` (role
`Viewer`) and `TEXT_FILE_TYPES` (role `Editor`) in
`src/shared/surface-link.ts`, the lists `isBrowserFile` and `isTextFile`
are built from; a test keeps the config and the lists equal. Every type has
rank `Alternate`: Work appears under Open With and accepts a Dock drop, but
becomes a type's default only when the person picks it (Get Info, Change
All).

**An opened file takes the external link's path.** macOS delivers it as
`open-file`; the main process queues its `file://` URL beside links from
other apps, and the window takes it:

- A text or code file opens in an editor tab of the project open in the
  window, inside the project or outside it (the editor reads and saves by
  absolute path); Markdown opens in the rich editor. With no project open, a
  tab shows it as plain text, as a downloaded text file is shown.
- Anything else a tab renders opens in a browser tab.
- A file already open comes forward instead of opening twice. Switching to a
  page's open tab now covers `file:` pages as well as web pages, so a file
  link in a chat also goes to the file's open tab.
- A file Work cannot show (reached through Open With, Other) is revealed in
  Finder, as a download is.

## Consequences

- Adding a format to either list adds it to Open With in the next build; the
  test fails until the builder config lists it too.
- macOS only: Windows and Linux builds register no file types, and argv
  paths are not read.
