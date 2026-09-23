# 0154: History belongs to the profile

- **Status:** Accepted
- **Date:** 2026-09-23
- **Builds on:** 0143 (profile history and browser import), 0153 (downloads in the dock)

## Context

ADR 0143 gave each desktop profile one history store, but the model inside
it was project-shaped: every entry that was not a web page had to be a
resource of some project, and nothing was recorded outside a project
workspace. A downloaded file opened as a tab (ADR 0153) was therefore
recorded as a file *of* the current project by absolute path, and a file
opened from the no-project browser was not recorded at all. The History
page had no way to look at one project's work.

## Decision

**History is the profile's log of what was opened.** Three kinds of
target: a web page (`web`, by URL), a file on this machine outside any
project (`local`, by absolute path), and a project resource (`file`,
`app`, `workflow`, `chat`, `run`, `artifact`, by project and resource,
where a project file's resource is its path relative to the project
root). Identity follows the target alone, so the same page or file seen
from two projects is one entry.

**Every entry may name the project it was opened in.** A project
resource always names its own project; a page or a loose file names the
workspace it was opened from, if any, and the latest visit decides. The
project is kept by id and name, so a deleted project still reads on the
page. The main process keeps a visit from naming a project outside the
profile.

**The History page scopes by project.** Its header carries a scope menu
listing every project the profile's history names ("All projects" plus
each name, newest visit first). Scope is a facet, not a filter field:
search stays with the palette's `history` mode (ADR 0123).

**A loose file reopens as it opened**: a browser tab showing what Work
can show, in the current window. A project resource reopens in its
project, switching workspaces when needed, as before.

## Consequences

- A `file://` tab of one of the project's own files is recorded as that
  project's file (relative path), so it reopens in the editor like any
  other; anything else on disk is a `local` entry.
- The web-visit recording IPC names the project of the browser tab's
  workspace; the window's profile is resolved by main, never sent.
- Existing `history.json` entries in the old shape are dropped on load
  (alpha; no migration).
