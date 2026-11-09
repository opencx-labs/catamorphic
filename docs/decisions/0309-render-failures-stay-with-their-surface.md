# 0309: Render failures stay with their surface

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

A command palette search exhausted the JavaScript stack during React rendering.
With no error boundary, React removed the window's entire interface. A failure
in one view must leave other tabs, their drafts, and workspace navigation usable.

## Decision

Use a shared desktop React error boundary at each tab pane and chat presentation,
with a separate boundary for the command palette overlay. A failure replaces only
that surface with an accessible retry and close view. Keep placement, tab identity,
and sibling views outside the boundary. Retry explicitly remounts the failed
content; changing tabs must not reset healthy retained content. Closing a failed
palette and opening it again starts a fresh attempt.

Keep a final window boundary for failures outside these surfaces, so an unexpected
shell render error still offers recovery. Preserve the error and component stack
in local console diagnostics. A window-wide reload is not the routine recovery
path for a failed tab.

## Consequences

Render and React lifecycle failures are contained without new processes or a
second workspace model. State held only inside failed content can be lost when
React unmounts it; sibling state and saved work remain intact. Async failures and
event handlers still need their existing explicit error handling. Renderer
termination, memory exhaustion, and a blocked event loop remain separate failures.
