# 0096: Desktop resource links use workspace targets

- **Status:** Accepted
- **Date:** 2026-09-07

## Context

Agent reply links all opened as browser pages, while file chips and
`open_surface` had separate routing. This broke code and Markdown links and
left workflow graphs without an agent-facing link contract.

## Decision

Extend the existing workspace targets, with one desktop resolver shared by
reply links, file chips, sidebar files, and `open_surface`. `workflow:<name>`
and `app:<name>` address the current project's existing resources. `file:<path>`
and ordinary absolute or project-relative file links select the file's viewer.
Code uses Monaco, Markdown uses Tiptap, and PDFs, HTML, images, and media use
browser tabs. Source links accept line and column locations. Desktop-local
artifacts outside the project use the same editor surface with host-local
file IO; they are not represented as project files or published by project APIs.

Retain click, Command-click, and Command-Shift-click navigation. Agent-initiated
opens preserve the existing foreground/background attention rules. Resource
tabs can attach to the originating chat just like file and browser tabs.
Do not add a second URL scheme or a separate artifact object model.

## Consequences

Agent guidance names actual resource targets and file paths. The registry's
Markdown renderer preserves supported target protocols only when its host
intercepts link clicks, keeping other protocols subject to its sanitizer.
Hosts continue to own navigation and local file access. Local text IO rejects
binary/oversized files and detects changed-on-disk content before saving.
