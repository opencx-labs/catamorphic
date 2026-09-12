/** Replaceable desktop doctrine. Mechanics live in the existing host services. */
export const DESKTOP_WORKSPACE_SKILL = `---
name: desktop-workspace
description: Work with the user's browser, terminals, chats, worktrees, connections and shared project state in Catamorphic. Load for desktop interaction or session coordination.
---

# Desktop workspace

Use native file and shell tools for ordinary work in your assigned checkout or
sandbox: reading, searching, editing, tests, builds and installing dependencies.
Bun is on PATH; the native desktop also supplies CATAMORPHIC_BUN. Do not search
the whole machine for executables. The execution context identifies where shell
commands run. A path on the desktop is not necessarily available in a sandbox.

Host operations are discovered with discover_capabilities. Search a short topic
(browser, terminal, sessions, worktree, skill, connection, app or workflow), then
invoke_capability with the exact returned name, input schema and a requestId.
Discovery is bounded; use its nextCursor when necessary. Do not assume access to
a tool merely because a skill mentions it. Reuse requestId only when retrying the
same invocation and check uncertain writes before trying again.

## Reading and presenting

The workspace snapshot is background data. ACTIVE identifies what the user is
looking at. workspace_overview refreshes it; discover read_tab for live page,
terminal, selection or chat details. Read ordinary source with native tools.

open_surface presents tab keys, file:<path>, app:<name>, workflow:<exportName>,
or web URLs. Its result tells you whether the user saw it or it opened in the
background. Link deliverables with Markdown: [Title](app:returnedName),
[Title](workflow:exportName), [Source](file:project/path), or absolute file paths.
A workflow source file opens code, not the workflow graph. Use semantic links.
Use the real returned names. Highlighting is optional: discover point_at, using
target: null to clear. Changing chat icons is optional and never a required step.

## Browser

Discover open_browser, browser_snapshot, browser_act and surface_control. These
control a real tab in the user's profile, including its existing sign-in state.
Take a fresh DOM snapshot before acting on opaque references and after navigation
or changes. Use snapshot format image for visual inspection, with returned CSS
viewport dimensions for coordinates. The user sees the work and can take over.
Respect a takeover; reclaim only when the task needs it and without disrupting
their active work. Release a useful tab when finished; close temporary scaffolding.
Simply showing a URL uses open_surface and does not need browser control.

## Terminal

Use native shell for routine execution. Discover run_terminal, read_terminal and
write_terminal when the user needs a visible persistent desktop terminal, an
existing terminal's output, or interactive input. These act on the desktop host,
not a remote sandbox. Reuse terminalId for sequential commands. Long commands
return commandRunning; wait with read_terminal using sinceOffset and waitForIdleMs
instead of starting the command again. Raw input uses a carriage return to submit
and Ctrl+C to interrupt. surface_control releases or closes the terminal. Closing
a terminal ends its process. Background terminals appear as chat chips; show one
with open_surface when useful.

## Sessions, progress and checkouts

Use update_todo_list for useful multi-step progress visible to the user. It replaces
the whole list; preserve existing item ids and omit obsolete items. Read the list
through discovery when its latest state is needed. Do not maintain a competing
private native todo list.

Discover list_project_sessions and read_project_session for authorized peer
context. children_only lists your direct children. send_project_session_message
has message_only, next_turn and interrupt delivery; use interrupt for urgent
course changes. spawn_subsession delegates bounded work through allowed routes;
wait_for_subsessions waits for results; interrupt_subsession stops a child.
Use request_user_attention only when the user should see a latent session.
Host sessions own delegation; do not use a private harness delegation mechanism.

Follow the supplied coordination strategy. Git facts use native commands.
Discover create_worktree or use_worktree to change this session's assignment;
use_worktree with path: null returns to the primary checkout. A shell cd does not
reassign the session. Copy only task-needed ignored settings into a new worktree,
never a credentialed environment file wholesale. Shared checkouts share commits
and rollback. Activity publication is optional when it adds useful peer context.

## Apps, workflows, sharing and connections

Use session-artifacts for temporary apps/reviews; building-apps for project apps;
workflow-lifecycle and writing-workflows for workflow execution. Author source
with files/code and reuse project component libraries. Discover build_app for a
host preview. Publishing requires publish: true and is separate from preview.

Attached checkouts follow the user's/project's commit instructions. Managed
projects may checkpoint and sync automatically. Do not commit just to save work.
Discover sync_project and create_pull_request for managed linked-remote operations;
they preserve the host's sync, checkout and conflict policies. Do not substitute
raw push/pull for managed sync. Unrelated repository tasks may use ordinary git.

Discover the required connection by service name, then its tools. Authentication
stays in the host UI. Discover request_connection for a missing service; never ask
for credentials in chat. If installation needs another turn, follow its returned
continuation instructions. Use tools only within the user's authorized task.
`;
