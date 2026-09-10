# 0113: Configurable workspace frame and local PR access

Status: Accepted

## Context
Workspace spacing and rounding were coupled to tab placement. Sidebar separators
were fixed. PR reads ignored an existing local GitHub CLI account.

## Decision
The desktop exposes independent, scoped content padding, corner radius and sidebar
divider settings through its existing settings registry. Defaults are 6px, 14px
and no divider. Zero is valid. Sidebar collapse controls belong to sidebar chrome;
a closed sidebar retains an external expand affordance.

The desktop can use the existing github.com CLI credential for local repository
PR reads, using the actual origin remote and the shared GitHub API client. Tokens
stay in main-process memory. Missing CLI credentials show CLI sign-in guidance; PR reads never fall back to the separate GitHub App sign-in. Framework embedders continue to own their CodeHost implementation.
MCP installations are not assumed to supply authenticated GitHub API credentials.

Bookmark pin destinations stay visible when empty. Hover inspectors dismiss during
dragging so they cannot obstruct targets. Large inspector lists use LazyList.

## Consequences
Settings remain file-editable, searchable and resettable with existing inheritance.
CLI authorization failures remain visible instead of silently switching accounts.
