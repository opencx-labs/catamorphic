# 0304 - Closing a folded tab group closes its tabs

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

A folded chat tab group shows one header for several tabs. Closing that header
removed the chat alone, leaving its hidden subtabs as unrelated top-level tabs.
The person explicitly asked for every way of closing a folded group to close
all its subtabs too.

## Decision

Closing a tab chat whose `surfacesCollapsed` flag is set closes its attached
workspace tabs, then the chat, through the existing workspace `close` transition.
This applies to the tab's close button, Cmd+W, chat controls and other callers.
Closing an expanded chat retains its current behavior. Background resources that
were not workspace subtabs keep their existing lifecycle.

The person chose all-or-nothing closure: the host asks about unsaved edits,
then checks every affected page before removing any tabs. Unsaved file edits
or workflow drafts ask before the group closes; confirmation discards the
group's drafts. Cancellation leaves every tab loaded and the group visible.
Guards run before chat exit motion.

A temporary listener in the isolated page preload makes Electron's native
beforeunload check non-destructive even for a page with no handler. It exists
only during the close attempt. Native replies are vetoed until the host removes
the group; request identities reject cancelled or late answers. Cancellation
releases approvals, retaining only the close's finite activation protection.
An unresponsive check does not approve a group close. Overlapping closes share
no approvals. The existing
closed-tab history records the children before the chat so the first reopen
returns the conversation. No parallel group-close event or stored group model.

Rejected: removing only the header, special behavior in each close button, and
closing approved tabs before later pages answer. The latter cannot preserve
the whole group when a later page chooses Stay.

## Consequences

One close transition owns the behavior; native cleanup and leave guards remain
in the desktop host. Closing a folded group disposes its open resource views.
Its conversation remains available in the sidebar, as with an ordinary chat close.
