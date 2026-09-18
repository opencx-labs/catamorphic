# 0143 - Profile history and browser import

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Browser import currently transfers bookmarks and passwords independently. History
only covers web pages, and onboarding cannot offer the same import experience as
Settings. Users want to bring their browser context and reopen their work together.

## Decision

Use one profile-local history store for web pages and stable, reopenable project
resources: apps, files, workflows, chats, runs and artifacts. Extend the existing
host-owned history primitive; do not create a parallel project activity log or
sync personal browsing to a server. Preserve imported visit dates and merge by
resource identity. Exclude incognito chats, authorization pages and transient UI.

One import dialog and one operation serve onboarding and profile settings. Users
choose a browser profile and categories before import: bookmarks, history,
passwords and signed-in sessions where supported. Read source stores without
modifying them. Use ordinary OS-authorized access for compatible encrypted
cookies, preserve cookie scope and expiry, and never bypass browser protections.
Keep existing destination credentials and cookies. Do not display skipped-item
reports. Cancellation and whole-operation errors remain truthful and retryable.
Onboarding returns to its existing actions with the import button marked complete.

Browser SQLite reads use owner-only temporary snapshots of the database and its
WAL/rollback journal. Verify stable source fingerprints and SQLite integrity,
recover only the copy, query it read-only and remove it immediately afterward.
This supports Chrome's exclusive locks without closing or altering the source
browser. Never export decrypted credentials or encryption keys to a temp file.

The History page and `history` + Space palette mode share the same query and
resource-opening behavior. The page's Search button opens that palette mode.
The page provides individual removal and clear history controls.

## Consequences

History is personal to a desktop profile, including its projects. Browser address
suggestions use the web subset. Imported cookies may avoid website sign-in, but
GitHub App authorization and repository grants remain explicit. Supported imports
vary by browser and OS. The old independent import APIs are replaced outright.
