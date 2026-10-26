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
folder disclosure are not navigation. Context menus expose the same four labels;
a link's menu in a web page offers the three that open elsewhere, since a click
opens it here. There is no shortcut for converting the current surface to floating.

Web links also offer **Copy link**, which copies their complete destination,
including a query and fragment. This applies to chat links, inline URL and
browser-tab pills, ordinary links in Work, browser tabs, palette web rows and
history rows; a web page's own menu offers the same copy as **Copy link address**.
File links keep their file actions.

Cmd+Shift+V (Ctrl+Shift+V outside macOS) pastes without formatting using the
same native paste-and-match-style command as the context menu. Work preserves
the platform's other native Edit menu commands.

An open menu holds the window, as a native one does (ADR 0221): the next press
anywhere else, a web page included, only closes it, and a right-click elsewhere
opens that place's menu. Escape, focus leaving it, the window losing focus, and
the menu's row scrolling away, hiding or turning inert (its sidebar closing)
close it too, and focus returns to where it was. Menus opened by a right-click
start at the pointer.

A page already open in a tab opens there (Settings, Browser: "Switch to a page's
open tab", on by default): a link or bookmark clicked, a page's link to a new
window, and a link from another app. A new tab asked for on purpose (Cmd-click,
"Open in new tab", a New Tab's palette) opens another. Cmd+P lists an open page
once, by its bookmark's name when it has one, and goes to its tab; a New Tab's
palette opens the page in that new tab. Pages an agent is driving don't count.

Opening here can reuse a compatible clean browser/editor. Preserve dirty buffers
and running sessions. An existing surface retains identity when focused, tiled,
floated or restored. A collapsed tab group affects the strip, not materialization.

A chat open as a tab groups the tabs attached to it. Dragging a tab onto a chat
(past its tab's leading edge in the strip, onto its row in the sidebar's tabs)
attaches it, as if the chat had opened it, and opens a folded group; dropped
among another group's tabs it joins that chat, and dropped among the top tabs it
leaves its chat (`attach`, `attachBlocker`). A page an agent drives and an
agent's or remote chat's terminal stay with their chat; chats never nest.

Ctrl+` opens a terminal in the focused chat's working folder, including its
assigned worktree. The same applies to a floating chat and its Open terminal
action. Without a chat in focus, a terminal starts in the project folder. A
chat shown over another project or in a detached dock opens its terminal in the
chat's owning project, using the same configured shortcut and chat command. A
terminal records the originating chat, not a copied filesystem path: reopening
it resolves that chat's current assignment. A missing assigned checkout is an
error, never a silent fallback to the project folder. Server chats use the same
reference with a remote target; their shells still run on the server. Moving a
project between windows preserves this reference and adopts a running local
shell. Group attachment and the shell's execution context are independent.

Take control gives the person the keys to an agent's running terminal. When
its command ends, an open tab keeps the output and says "Command finished".
"Open new shell" starts a fresh user terminal below that history, in the owning
chat's current working folder. The finished command stays ended and does not
run again. A finished terminal has no blinking work indicator or typing cursor.

A New Tab (Cmd+T, the palette as a page) is a way to somewhere, not a place. Once
something else is shown in its place, a New Tab with nothing in its input closes
(`reconcileWorkspace`); one with typed text or an entered mode, or one still on
screen as the other pane of a split, stays. Its input is not restored on relaunch,
so neither is that mark. A chat asked for while a New Tab is in front (Cmd+N, New
chat, Send to agent or a skill from the New Tab's palette or the overlay) opens in
that tab: it takes the New Tab's place in the strip and in a split, and the New
Tab closes, typed or not (`openChatInNewTab`). An empty chat already floating over
the New Tab moves into it instead; a floating chat with a conversation is minimised
as the new one takes the tab, and a surface floating over the New Tab keeps it.
Elsewhere Cmd+N floats a chat as before. Chats Work starts for something else (the
sidebar's customization chat, a workflow's) keep their own placement; the dock's +
never takes a New Tab, it starts its chat in the dock; and a chat switched to
another harness from a floating chat floats beside it.

Closing a web tab never runs a script probe in its page first. Main records
interaction with the current document as it happens and lets Chromium run the
page's own `beforeunload`, when applicable. Only that handler can ask to stay;
Work adds no confirmation. A native page close completes the tab close immediately,
without waiting for a guest event to reach the renderer's fallback timer.

Closing the tab in front goes back to the tab the person was on before it, the
newest one still open (`recentTabKeys`, kept with the workspace): Cmd+W on a page
opened from a chat's link returns to that chat. Closing one pane of a split lands
on the other pane first.

The mouse's back and forward buttons move between the places a project's
workspace was at: the focused tab and the chat or surface floating over it
(ADR 0188, `lib/surface-history.ts`), selecting tabs as a click would. A
press on a browser's page or toolbar walks that browser's pages instead and
stops at its first and last page; a press on a dialog does nothing; a press
anywhere else walks surfaces. A browser tab reopened with Cmd+Shift+T, or
restored with its window, keeps its back and forward list.

## Chat presentation and visibility

Full-tab chats stay in the tab bar when another resource takes focus, with no dock
bubble; switching to or from one is as instant as switching pages. Floating and
minimized chats have bubbles, and only they speak through the dock: the folded
bubble shows their activity and what needs the person, while a chat in a tab says
so on its tab. Maximizing a floating chat makes it a normal tab, removes its
bubble, and keeps it visible when the dock collapses. Chat controls show their
applicable shortcut on hover, using the configured binding; returning a tabbed
chat to floating shows Escape. A normal link from a floating
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

Agent opens and closes (`open_surface`, `surface_control`) take the person's
paths: an open is placed as a press on the surface's chip places it
(`openSurface`), a floating surface leaves with its exit first, and a close is
the tab's close. When either changes the tab in front of the visible workspace,
the content arrives with `pane-in` from that side of the strip; a person's click
stays instant. An open goes in front only when this project and its window are
on screen and the person watches the asking chat, talks with it by voice, or
already looks at the target; otherwise, including for a session with no chat
here, it is prepared in the background and reported so. An agent terminal's
`open` names no session: it asks for the working chat, and opens in front when
there is none. A page opened in front for a chat that is not on screen gets its
own tab instead of replacing the page in front.

## Sidebar defaults

New profiles use top tabs and no framed content. A single sidebar tab hides its
strip. Every list section is a source (ADR 0234); the default left sidebar lists
pinned pages, the library, bookmarks, workflows, apps, the window's tabs (only
while tabs are placed in the sidebar), files and the project's server. There is
no chats list by default: chats are tabs, and the palette finds every chat. With
tabs placed in the sidebar, the Tabs section (`work:tabs`) is the tab list, and
a layout without a section listing tabs keeps them in the top bar whatever the
setting says. The right sidebar is empty by default. A tab whose sections show
only beside a chat (`when: { session: true }`) comes and goes with what is in
front and is never the default choice, so its arrival never changes the tab
shown (ADR 0226). A session-scoped section's links open as the chat's links do.
Left sidebar profile/settings controls remain sticky at the bottom.
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
new window (its card's last line in the project switcher, or a Cmd-click on its
row) focuses the window showing it when one is. A project a window only keeps
behind the one it shows moves to the new window instead: its workspace, unsent
chats and running shells go with it (shells on this computer are taken over, not
restarted; a remote chat's shell opens again on its server), its pages load
again, and agent calls for it wait until the new window has opened it. Unsaved edits in a file keep the project where it is
until they are saved or discarded; that window says so. A new window cascades
from the one it came from and carries its project's name, so the macOS Window
menu lists it and Cmd+` reaches it. Closing an occupied window hides it;
explicit Quit owns shutdown. The palette's **Close current Work window** uses
that same lifecycle, including in an empty window. Cmd+W continues to close the
focused tab or chat. **Rename current chat…** uses the existing rename dialog
and can name the current chat while its bubble is minimized.

A restart, including an update, restores every workspace window with its profile,
owned project group, active project, normal bounds, maximized/fullscreen modes,
and visible or hidden presentation. The last focused visible window comes
forward after the set is restored. A minimized window stays minimized. An
occupied window that was hidden stays hidden with its project resources alive;
a truly closed empty window is removed. Detached docks, sign-in popups, extension
windows and voice bubbles follow their own existing lifecycles.

The app-owned `window-state.json` stores this window collection. Each project's
existing workspace store remains the one source for tabs, chats and layout.
Startup reserves all saved project owners before renderers begin claiming
projects or monitoring attention, then validates those claims against existing
project records. A fallback selected from profile preferences is only a request:
its project resources and saver mount after the existing ownership claim succeeds.
An empty restored window cannot mount or save another window's project. Deleting a
project removes its claim and retained runtime. Quit
and update restart ask every initialized workspace to flush its current project
saves and await their acknowledgements before freezing the complete window
collection and closing any window. Teardown cannot replace it with the shrinking
set. Failed updates, declined moves and prevented native closes resume persistence
for the next attempt. Positions unavailable on the current screens are recentered.

The profile can show chats from the current project or all its projects, attach
or detach the dock, and choose edge or centered expansion. Current-project scope
also applies to chats needing attention, including subagents and forks. Opening
and acknowledging a chat never changes which project it belongs to. Drag the collapsed
bubble or expanded handle horizontally to change bottom corners. It lands on
the resting spot nearest its centre, leaving its own after 40% of the way to
the next, and slides there, back to where it started included. Persist only
left/right, never coordinates. Dragging must not trigger expansion; Escape
cancels and arrow keys select a corner. Settling respects reduced motion.
Folding the strip (its arrows) is the person's choice, saved with the profile
(`dockCollapsed`) and shown in every window and the detached dock until they
open it again from the collapsed bubble. Folded beside an open chat, the strip
folds while that chat minimizes or closes, as one motion, however it leaves
(the arrows, Escape, its own controls, its bubble, the shortcut); the detached
window waits for the chat, since its size follows it. Turned back mid-way,
the fold returns from where it is and its slide and width land together. A
control the fold makes inert hands focus to the one that replaces it (the
arrows and the collapsed bubble, each with `aria-expanded`). A focused chat
tab folds the strip and an open chat opens it beside the chat, each only for
as long as it lasts; neither changes the choice.
A detached dock stays above other apps and follows macOS desktops. Chat cards
and bubbles retain their project's theme; the new-chat control follows the
current project. Files, links and session controls route to their owning project,
using the same resource-opening gestures as other workspace surfaces. Project
switches use a 180ms, low-opacity accent tint; reduced motion disables it.

## Search and resource references

File discovery uses the command palette exclusively. A section's header actions
are its own buttons (ADR 0234): Find files runs `command:search-files`, and a
`search` header action opens a palette scoped to that section's rows. Do not add sidebar search inputs, a second
file-picker modal, or an editor toolbar search button. Content search remains a
separate palette mode. The "Ask agent" action names the default agent as secondary
text and never echoes the draft message.

Every palette mode has one shape (ADR 0186): a chip, typed names, and rows that
are ranked, computed, or loaded. Type a name then Space or Tab, or pick it from
the @ list; Backspace on an empty input leaves. Choice pickers, sidebar searches,
Sites, Commands (also `>`), Skills (also `/`) and workspace.js `palette.modes` all
use it. Results rank by match, row kind and use: commands and surfaces before
pages, frequent destinations first, and rows picked earlier for a query. The
empty palette shows starting actions, the focused site's settings, then up to
six Frequent rows.

The palette's Skills mode (ADR 0270, Cmd+P then `/`): Enter applies a skill to
the chat in front, ⌘↵ starts a chat with it, ⌥↵ a floating one. Tab, or Space
after a full name, puts the skill in the chip and takes its instructions;
Backspace on them returns to the list. Applied to its chat, a skill takes the
pills of a composer with no prose along; a new chat starts with the skill alone.

A composer has menus of its own (ADR 0274), opened by the word the caret ends:
`/` or `@` starting any word, mid-message too, opens a one-line-per-row list
above the composer, and typing goes on in the composer. A second `/` or `@` in
the word (a path, an address) closes it. ↑/↓ move, Enter or Tab picks, Escape
closes the menu for that word and keeps the typing; the next word opens it
again. `/` lists the chat's commands (Status, Agent ›, Model ›, Effort ›,
Permissions ›, Fork chat, Archive chat), which run at once and take their word
away, and the skills, which become a skill pill where the word was (Space after
a full name too). A harness's own commands are listed only when `/` starts an
empty message: Enter sends them as written, Tab keeps them for arguments. `@`
lists open tabs, the chat checkout's files and folders, chats, workflows and
apps, each picked as a pill. Both rank with the palette's index and use.

Find (`find`, Cmd+F) acts on what is in front: a web page opens its find bar,
a diff focuses its own search, and anywhere else the key stays with what has
focus (an editor's own find). In a page the key reaches the page first, as in
Chrome: a page with its own find keeps it, and only what the page leaves opens
the bar (`PAGE_FIRST_ACTIONS`; a find key pressed inside an embedded frame
stays the page's). Cmd+G and Cmd+Shift+G step through the matches. The bar
closes on Escape with the current match selected, and when the tab shows
another page.

Back and forward (`browser-back`, `browser-forward`, Cmd+Left and Cmd+Right)
reach a page first the same way. A text field keeps a caret key for its caret,
whatever the key is bound to (`fieldKeepsKey`): an arrow, Home or End with the
modifiers the platform's text system moves by (none, Option or Cmd on macOS;
none or Ctrl elsewhere; each also with Shift). So in the address bar, the chat
composer, an editor or a page's input, Cmd+Left and Cmd+Right move to the
line's start or end, while a binding such as Cmd+Option+Left still runs there.
Inside an embedded frame, which has no preload, main asks the focused frame:
back and forward go unless the key is a caret key and the frame's focus is (or
may be) a text field. A frame's own claim on the key is not seen there, unlike
the page's main document. Elsewhere they go back and forward.

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


## Keyboard and chat identity

Back and Forward, including mouse buttons, keyboard shortcuts, swipes and page
menus, move one explicit Chromium history entry. Automatic full-page and
same-document navigation remains reachable even without page activation.
Work does not manufacture entries for a page's `replaceState` operation.

Clicks on empty chat gutters focus the composer. Links, controls, message text,
code and an active text selection retain their normal behavior.

Maximizing and floating a chat animate the conversation and composer's maximum
width with their padding. The composer must not briefly narrow and wrap while
the surrounding card expands or contracts. Folder and unsupported-file previews
show their summary; retry is offered only after an actual preview read failure.

Browser pages receive shortcuts that belong to another surface. In particular,
Cmd+Enter (Ctrl+Enter outside macOS) belongs to a focused review comment form only
while that form is focused; a page or embedded frame keeps it for its own submit
action. Work's window and navigation shortcuts retain their configured bindings.

The palette's Ask agent mode shows the default agent's harness mark and its name,
model name and reasoning effort, separated by middle dots. Unpinned models resolve
from the harness for the current project; focused-chat overrides do not change the
identity of a new chat. Unsupported reasoning controls are omitted.
