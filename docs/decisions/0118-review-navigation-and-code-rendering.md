# 0118: Review navigation and code rendering

- **Status:** Accepted; sidebar search and editable-file theme behavior superseded by [0123](0123-desktop-consent-search-and-resource-links.md)
- **Date:** 2026-09-10
- **Supersedes:** The editor palette paragraph of 0107

## Context

The desktop needs navigable pull-request reviews, reliable file discovery, and
readable diffs across large changes. The user requested Pierre Diffs, Shiki themes,
a review guide and personal PR lists, with filename search only in sidebars.

## Decision

Use `@pierre/diffs` for local and remote diffs. Keep Monaco for editable files,
using the official Shiki adapter. A profile-owned code-theme preference selects
paired light and dark syntax themes for both. The application still owns its
chrome, typography and light/dark mode. Both renderers remain lazy and use bundled
assets. This replaces Monaco diff rendering and its app-palette-only syntax colors.

File sidebars filter paths. Cmd+P has distinct Files and File content modes;
review content search belongs in the review toolbar and inside the diff. Local
content search respects Git exclusions, avoids symlink traversal, bounds reads
and results, and reports incomplete searches.

Reviews have an original, local Guide organized from changed paths, with direct
navigation into Changes and local reviewed-file state. Path grouping is presented
as navigation assistance, not generated claims about correctness. PR lists expose
For you, Created and All. Reading and local review state do not submit a review.

Changes follows the active chat checkout by default, retains the last chat scope,
and supports an explicit per-project checkout selection. Discovery can list all
worktrees, but status and branch comparisons run only for requested checkouts.
Hidden Changes sections stop polling; visible file rows are virtualized.

Build presentation from controlled primitives. `DiffView` accepts renderer options,
layout, wrapping, change callbacks and a toolbar slot, without a desktop API or
preference-store dependency. `CodeDiff` is the desktop adapter. Diff layout and
wrapping, review starting view and grouping, PR list and changed-file layout are
declared preferences, editable in Settings or the live profile configuration.
Do not bury these choices in component state or opaque browser storage.

## Consequences

The desktop owns these UI choices; no renderer dependency enters the backend SDK.
Remote patches can omit binary, large or unchanged content and must expose that
limit. Guide generation, review submission and richer code-host metadata can evolve
without changing the file-search or diff-renderer contracts.
