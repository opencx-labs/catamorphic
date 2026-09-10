# 0116: Bookmark library and pins

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Browser imports populated the pinned grid, overwhelming daily navigation. The
user requested separate saved bookmarks and explicit pins.

## Decision

Browser imports populate a profile-wide bookmark library, preserving recursive
folders and deduplicating exact URLs on repeated imports. Pinned shortcuts remain
separate, as do project bookmarks. Existing pins are preserved on upgrade; we do
not guess which existing entries were accidental imports.

Pinning a library entry creates a shortcut with the same identity without moving
its saved folder location. Unpinning removes that shortcut and leaves the library
entry intact. Legacy project pins retain their existing return-to-project behavior.
Each collection has a bounded sidebar scroll region and an explicit label.

## Consequences

Importing many bookmarks cannot crowd out explicit pins. Storage adds an optional
profile library map to the existing local file with an empty default for old files.
The accidental import reset is a one-time, backed-up user data operation, not an
automatic migration that would erase another user's bookmarks.
