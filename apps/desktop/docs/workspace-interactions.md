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

A New Tab (Cmd+T, the palette as a page) is a way to somewhere, not a place. Once
something else is shown in its place, a New Tab with nothing in its input closes
(`reconcileWorkspace`); one with typed text or an entered mode, or one still on
screen as the other pane of a split, stays. Its input is not restored on relaunch,
so neither is that mark.

The mouse's back and forward buttons move between the places a project's
workspace was at: the focused tab and the chat or surface floating over it
(ADR 0188, `lib/surface-history.ts`), selecting tabs as a click would. A
press on a browser's page or toolbar walks that browser's pages instead and
stops at its first and last page; a press on a dialog does nothing; a press
anywhere else walks surfaces. A browser tab reopened with Cmd+Shift+T, or
restored with its window, keeps its back and forward list.

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

New profiles use top tabs and no framed content. A single sidebar tab hides its
strip. Left sidebar profile/settings controls remain sticky at the bottom.
The right sidebar toggle stays at the workspace header's right edge, including
before a project is open and while the left sidebar is collapsed.
An empty right sidebar starts closed on launch and context changes. Configured,
authorized sections count as content even when their lists are empty. Automatically
hiding an empty panel never overwrites its populated profile preference. Manual
opening for customization is temporary until content is added.
An empty right sidebar, including a window with no project, shows a centered
Customize sidebar button. Both sidebar controls reveal the same open customization
chat. Starting from an empty window creates the default project and completes any
required agent setup before sending the customization request.

## Verification

Run the workspace-state and workspace-layout unit tests, then Electron suites
`chat-state`, `floating-surfaces`, `dock-modes`, `sidebars`, and `motion` as relevant.
Check native hit targets and resting geometry, not just DOM presence.

## Project windows and the shared dock

Each project has one live workspace owner. Switching projects preserves mounted
editors, terminals, browser pages and agent tool handlers. Opening a project in a
new window focuses its existing owner when already open. Closing an occupied
window hides it; explicit Quit owns shutdown.

The profile can show chats from the current project or all its projects, attach
or detach the dock, and choose edge or centered expansion. Drag the collapsed
bubble or expanded handle horizontally to change bottom corners. It lands on
the resting spot nearest its centre, leaving its own after 40% of the way to
the next, and slides there, back to where it started included. Persist only
left/right, never coordinates. Dragging must not trigger expansion; Escape
cancels and arrow keys select a corner. Settling respects reduced motion.
Folding the strip (its arrows) is the person's choice, saved with the profile
(`dockCollapsed`) and shown in every window and the detached dock until they
open it again from the collapsed bubble. A focused chat tab folds the strip and
an open chat opens it beside the chat, each only for as long as it lasts; neither
changes the choice.
A detached dock stays above other apps and follows macOS desktops. Chat cards
and bubbles retain their project's theme; the new-chat control follows the
current project. Files, links and session controls route to their owning project,
using the same resource-opening gestures as other workspace surfaces. Project
switches use a 180ms, low-opacity accent tint; reduced motion disables it.

## Search and resource references

File discovery uses the command palette exclusively. Searchable sidebar section
headers put a search button on the right, opening a palette scoped to that
section's items and current filters. Do not add sidebar search inputs, a second
file-picker modal, or an editor toolbar search button. Content search remains a
separate palette mode. The "Ask agent" action names the default agent as secondary
text and never echoes the draft message.

Every palette mode has one shape (ADR 0186): a chip, typed names, and rows that
are ranked, computed, or loaded. Type a name then Space or Tab, or pick it from
the @ list; Backspace on an empty input leaves. Choice pickers, sidebar searches,
Sites, Commands (also `>`) and workspace.js `palette.modes` all use it. Results rank
by match, row kind and use: commands and surfaces before pages, frequent
destinations first, and rows picked earlier for a query. The empty palette shows
starting actions, the focused site's settings, then up to six Frequent rows.

Find (`find`, Cmd+F) acts on what is in front: a web page opens its find bar,
a diff focuses its own search, and anywhere else the key stays with what has
focus (an editor's own find). In a page the key reaches the page first, as in
Chrome: a page with its own find keeps it, and only what the page leaves opens
the bar (`PAGE_FIRST_ACTIONS`; a key pressed inside an embedded frame stays
the page's). Cmd+G and Cmd+Shift+G step through the matches. The bar closes on
Escape with the current match selected, and when the tab shows another page.

Back and forward (`browser-back`, `browser-forward`, Cmd+Left and Cmd+Right)
reach a page first the same way, and a text field keeps them for its caret:
in the address bar, the chat composer, an editor or a page's input they move
to the line's start or end (`TEXT_FIELD_ACTIONS`). Elsewhere they go back and
forward.

Default sidebars do not include a project note. Notes are opt-in widgets over
explicit existing documents, not filler in a new project's right sidebar.

Agent replies use standard Markdown resource destinations:

| Resource | Destination | Opens |
|---|---|---|
| Workflow, including drafts | `workflow:<exportName>` | Workflow graph |
| App | `app:<appName>` | App surface |
| Document or source | `file:<project-relative-path>` | Appropriate file surface |
| Existing workspace surface | Its discovered tab key | That same surface |
| Web page | `https://…` | Browser |

Use actual discovered names and URL-encode destination characters. Agents must
link workflow/app deliverables as those concepts. Do not label a TypeScript source
link as the workflow. Source is an explicitly labeled secondary link when useful.
Keep links aligned with `parseSurfaceLink`, `open_surface` and URL sanitization.

## Personal history and browser import

History belongs to the desktop profile. It includes web visits and stable project
surfaces: apps, documents and other files, workflows, chats, runs and artifacts.
Incognito chats, authorization pages and transient utility screens are excluded.
Entries reopen through the same resource-opening gestures and route to the
project's owning window. Search queries the full retained history. Type `history`
then Space in the palette; the History page's search button opens that same mode.

Onboarding and Settings use the same browser profile import dialog. Users choose
categories before starting. On success, onboarding shows its import button as
complete and keeps the existing next actions. Imports preserve existing accounts,
cookie scope and expiry, source visit dates and bookmark folders. Repeat imports
merge without duplicates. Unsupported individual items are omitted quietly.
Whole-operation errors are retryable and cancellation never marks import complete.
