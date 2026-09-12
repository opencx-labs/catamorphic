These fixtures were authored by a real Codex CLI agent on 2026-09-11 using the
project agent's desktop settings guidance and installed public package declarations.
They are retained as customization compatibility tests, not generated during CI.

The first exercise asked for a nested Docs section, independent inline/overflow/
right-click actions, a filtered working-chat source, and contextual subsessions.
`agent-sidebar.cjs` is the resulting whole-document configuration.

The follow-up asked for a sandboxed live widget built with the public collection
and item primitives. `agent-sidebar-widget.tsx` is the result (formatting only),
and `agent-sidebar-widget-entry.tsx` supplies its test mount.

`sidebar-contributions.e2e.ts` runs both in the actual Electron host, creates real
session records, verifies context changes and menus, and executes advertised
collection actions across the sandbox bridge. The widget is compiled from source;
only the app view-state lookup is intercepted to serve that built fixture. This
test covers customization and the host bridge, not the app deployment pipeline.
