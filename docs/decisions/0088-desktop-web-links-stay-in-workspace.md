# ADR 0088: Desktop web links stay in the workspace

- **Status:** Accepted
- **Date:** 2026-09-04
- **Refines:** 0043, 0055, 0072, and 0079

## Context

The desktop includes a full profile-aware Chromium browser, but some
desktop-initiated web handoffs still opened the operating system browser.
Remote-project sign-in was the clearest failure: connecting switched products,
lost the desktop profile context, and made a routine authorization flow feel
external to the workspace.

Browser tabs normally belong to a project workspace. A new profile can need to
authenticate before it has any project, so routing every web handoff through
that existing model needs a place for the first temporary tab without creating
a fake project.

## Decision

Every HTTP or HTTPS destination initiated by the desktop opens in a workspace
browser tab in the requesting profile. OAuth callbacks close their temporary
tab after the local callback is served. Non-web operating-system intents, such
as revealing a folder or moving one to trash, remain native shell actions.

Before a profile has a project, the renderer owns one transient, profile-scoped
utility workspace that can hold browser tabs. It is not a Catamorphic project,
is not persisted, has no terminals, chats, agents, or project bookmarks, and
disappears from view as soon as a project becomes active. This reuses the
existing browser tab and profile session primitives without inventing a second
browser implementation or a default project.

The stock server's sign-in and consent pages use the canonical Catamorphic
design language and remain ordinary semantic HTML forms. They are host pages,
not desktop renderer pages, and receive restrictive per-response security
headers.

## Consequences

Remote connection and other browser authorization flows stay visually and
contextually inside Catamorphic, including first-run onboarding. The existing
profile cookie jar and credential broker apply to those pages. Utility browser
tabs intentionally cannot create project bookmarks until a real project is
active, and they do not survive a restart.
