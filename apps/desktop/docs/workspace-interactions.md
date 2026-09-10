# Workspace interactions

## Opening resources

| Intent | Pointer | Keyboard |
|---|---|---|
| Open here | Click | Enter |
| Open in new tab | Cmd+Click | Cmd+Enter |
| Open to the side | Cmd+Shift+Click | Cmd+Shift+Enter |
| Open floating | Option+Click | Option+Enter |

Use Ctrl for Cmd and Alt for Option outside macOS. Explicit gestures take priority
over a configured default. Resource rows, sidebar items, palette results, chat links,
and attachments share this language through `shared/open-mode.ts`. Commands and
folder disclosure are not navigation. Context menus expose the same four labels.
There is no shortcut for converting the current surface to floating.

Opening here can reuse a compatible clean browser/editor. Preserve dirty buffers
and running sessions. An existing surface retains identity when focused, tiled,
floated or restored. A collapsed tab group affects the strip, not materialization.

## Chat presentation and visibility

Full-tab chats stay in the tab bar when another resource takes focus, with no dock
bubble. Floating and minimized chats have bubbles. A normal link from a floating
chat preserves that chat over the page; a floating resource preview minimizes it.
Its bubble restores the same conversation and draft.

A working floating chat can compact when the background receives focus. Hover or
focus expands it; leaving compacts it again. Completion or a question expands it.
Both panes of a valid split are visible regardless of keyboard focus. Visible
responses do not acquire hidden-chat unread or activity cues.

## State and motion ownership

`src/renderer/lib/workspace-state.ts` owns workspace identities, ordering,
serialization, reconciliation and navigation transitions. `workspace-layout.ts`
derives slots. IO, dirty-buffer prompts, native handles and animation scheduling
belong to the host. Delayed animation completion may finish only its initiating
layout, never overwrite newer navigation. Preserve mounted editors, terminals,
browsers and composers through presentation changes.

The [motion contract](../DESIGN.md#motion-contract) applies. Floating surfaces have
compact corner controls and paired 200ms entrance/exit. Settings navigation uses
200ms fade/8px arrival; search uses `useListMotion`. Reduced motion settles
immediately. Empty sidebar text is horizontally centered.

## Sidebar defaults

New profiles use top tabs and no inset tab frame. A single sidebar tab hides its
strip. Left sidebar profile/settings controls remain sticky at the bottom.
The right sidebar toggle stays at the workspace header's right edge, including
before a project is open and while the left sidebar is collapsed.
An empty right sidebar starts closed on launch and context changes. Configured,
authorized sections count as content even when their lists are empty. Automatically
hiding an empty panel never overwrites its populated profile preference. Manual
opening for customization is temporary until content is added.

## Verification

Run the workspace-state and workspace-layout unit tests, then Electron suites
`chat-state`, `floating-surfaces`, `dock-modes`, `sidebars`, and `motion` as relevant.
Check native hit targets and resting geometry, not just DOM presence.
