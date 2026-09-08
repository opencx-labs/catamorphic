# 0081: Recursive, agent-configurable sidebar trees

- **Status:** Accepted
- **Date:** 2026-08-31

## Context

The desktop sidebar supported ordered, collapsible sections, but custom items
were flat URL rows and bookmark folders were limited to one level. Browser
import consequently discarded Chrome and Firefox folder ancestry. Built-in
bookmark rows also had capabilities that an agent-authored section could not
express, making `sidebar.js` less powerful than the app's own sidebar model.

## Decision

Sidebar items use one recursive declarative shape. An item may be a URL, a
folder with nested `items`, or a URL that also owns collapsible children. Every
level supports the existing icon, open mode, menu, preview, and initial
collapsed state. Sections remain ordered and collapsible through the same
agent-editable `sidebar.js` layers.

Both project bookmarks and profile-wide bookmarks use the same recursive
folder relation. Browser import carries complete ordered folder paths into
that model, including empty folders. Existing flat profile bookmark arrays are
migrated on read. Web rows use observed favicons when available and an
origin-favicon/browser-page fallback otherwise.

## Consequences

- Agents can author sidebar trees with the same row detail and collapse
  behavior as built-in bookmark trees.
- Chrome and Firefox imports preserve nesting instead of flattening labels.
- Profile-wide bookmarks now have folders, so their serialized shape changes;
  the store retains a read migration for existing data.
- Recursive rendering and sanitization require cycle and depth defenses at
  data boundaries.
