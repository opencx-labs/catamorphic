/**
 * One reference for the live config template (every workspace.js starts
 * with it, commented) and the configuring-catamorphic-desktop skill. Keep
 * it the validated contract (workspace-config.ts) and ADR 0234: every list
 * is a source, Work's own lists included, and nothing here may promise
 * what the loader refuses. No backticks: it lives in a template literal.
 */
import { RESERVED_PALETTE_TRIGGERS } from "../shared/palette.js";

export const WORKSPACE_AUTHORING_GUIDE = `## Workspace: sidebars, chips and palette modes in workspace.js

workspace.js holds what the window offers: both sidebars, the chips above every
chat's composer, and your own command palette modes. Use the supplied workspace
paths. Precedence is built-in, profile, shared project (.work/workspace.js),
personal project. Each file replaces the entire document. Read the resolved
highest existing layer before copying it to a higher layer, then edit only the
intended parts. Preserve unrelated content. The profile file is the live,
commented schema/example; read it before editing.
Export with module.exports = { sidebars: { left: [...], right: [...] },
palette: { modes: [...] }, chips: { source } }; palette and chips are optional
and no other keys are allowed.
Delete an override file to inherit the lower layer again. The file is data:
no functions, no require. Code goes in source modules (below).
One left sidebar tab hides its tab strip; an empty right sidebar starts closed
(the built-in right sidebar is empty).

Tabs are icon tabs: { id, title, icon, sections: [...], when? }. Tabs and
sections keep stable ids through edits (letters, digits, - and _).

## Sections

A section shows exactly one of:
- source: "work:<name>", one of Work's own lists, or a module path relative to
  the project (".work/todos.ts") for your own code;
- items: static rows (links and folders of links);
- app: a project app's name, drawn compact;
- note: a project-relative document path, or true to let the person pick one.
There is no type and no built-in section with special powers: Work's lists are
modules on the same contract as yours, and every list draws the same way.
Presentation: title (the heading; "" for none; absent, Work's lists use their
own and a module section is headed Items, so give a module section a title),
presentation ("rows" or "tiles": tiles draw root rows without children as a grid
of icons), collapsed, hideEmpty (hide while it lists nothing; a hidden list that
takes drops shows while something it takes is dragged), empty (its one sentence
when empty), height (the most a list shows before it scrolls; a list fades the
edge it continues past), scrollbar (true adds a scroll thumb, a lane in from the
sidebar's own, while the list scrolls, and widens that sidebar's outer padding by
8px to hold it; off by default), rowHeight, open (default open
mode: replace, tab, side, floating), when, headerActions, menu, contextMenu,
actions, itemDefaults and itemOverrides (presentation for every row, or by row
id). Grants: collections (Work lists an app or module may read) and workflows
(workflows a module may call).

Work's lists (bare names in grants and work.read; work:<name> in source):
- pinned: pages pinned across this profile's projects (pin, unpin, edit,
  remove, rename-folder; drop and drag to reorder). The default draws it as
  tiles with no title.
- bookmarks: this project's bookmarks; header actions add (input url, label)
  and new-folder (input label); a folder's add puts the page in it. library: a
  browser's imported bookmarks.
- workflows, apps: the project's; a row opens it (workflow:<name>, app:<name>).
- chats: the project's chats, newest first, paged; their forks and children
  nest. Rows carry signal and data (the session's fields: running,
  attentionRequired, owner, createdAt, ...). Actions: rename (opens the
  rename dialog), new-subsession, mark-read, mark-unread, archive, unarchive
  (open-terminal for any chat, and open-preview for a server's chats).
- subsessions: the children of the chat in front; needs when: {session:true}.
- activity: chats working or waiting for you, and workflow runs going or
  stopped.
- files: the project folder as a tree, folders first (members of a server
  project: their files and the store).
- tabs: the window's open tabs in strip order; a chat's opened tabs nest under
  it, open. Rows carry signal (attention, then unread, then working), activity
  and data {kind, name, active, working, waiting (watch, subagent, command or
  null), attention (waiting for the person included), unread, groupId?,
  sessionId?, url?, faviconUrl?, path?}; actions close, and rename on a chat's
  tab (opens the rename dialog); drag reorders the strip, and a tab dropped on
  a chat nests under it (the chat keeps it among its chips) or, dropped among
  the top tabs, leaves its chat. Chat rows carry acceptsChildren.
- remote: a connected project's server: a status row (its dialogs), a row per
  file changed on this device (upload, history, publish), files needing a
  proposal. Header actions sync and upload-all.
- git: the project's checkouts and the files changed in each (people who edit
  the program only). prs: open pull requests (or a server's proposals).
- session: the chat in front: its folder and the pull requests its agent
  recorded under pull_requests. Needs when: {session:true}.
- resources: what Work runs, like Activity Monitor: a Total row, Work itself,
  then each chat, terminal, browser tab and sidebar module with processes;
  their processes nest under them (row ids pid:<pid>). Rows show CPU as a trend
  (percent of one core) and memory as the description; data has cpu, memory
  and the owner or pid and command. Actions: end (a process Work started, with
  what it started; on a chat or module, its processes), close (a terminal or
  browser tab). Read every 2 seconds while shown; not in any default layout:
  { id: "resources", source: "work:resources" }.
Row ids: session UUIDs for chats, paths for files, names for workflows and apps,
tab keys for tabs, store ids for bookmarks, numbers for PRs.

The default left sidebar: pinned, library, bookmarks, workflows, apps, tabs
(only while the person places tabs in the sidebar: when {tabPlacement:
"sidebar"}), files, remote. There is no chats list by default: chats are tabs,
and the palette finds every chat. Add { id: "chats", source: "work:chats" } to
list them.

Relevance is when, independent of permissions:
{ surface: ["chat"], session: true } shows beside a chat with a session;
{ session: true } also beside a page, file or terminal that chat opened (its
source then receives that chat as session, and a tab of such sections comes and
goes with it without ever taking the selection).
Other conditions: pathPrefix, selection (boolean), tabPlacement ("top" or
"sidebar", where the person placed the window's tabs), permissions. Surface
kinds include chat, editor, browser, terminal, workflow, app and diff. Tabs
leave the top bar only while a sidebar section lists them (work:tabs, or a
module granted tabs); otherwise they stay on top whatever the setting says.
An invalid when (surface: "chat" instead of ["chat"], an unknown
tabPlacement) hides its tab, section or item without an error: after editing,
check that it appears.
hideEmpty hides ready-but-empty content, not loading or errors. A tab
disappears when every section is unavailable. Every section shares one status
presentation: a header spinner while refreshing, placeholder rows first, one
muted sentence when empty, the error with Retry. Never draw your own.

## Rows

Every row, whoever wrote it, is the same: { id, label, url?, icon?, description?,
badges?, signal?, activity?, progress?, trend?, preview?, keywords?, hide?, parentId?,
hasChildren?, acceptsChildren?, collapsed?, menu?, contextMenu?, actions?, data? }.
- url is where the row goes, opened by one resolver: a web page, a chat
  (catamorphic://chat?project=&session=, or session:<id>), workflow:<name>,
  app:<name>, run:<id>, file:<path>, an open tab's key (browser:<id>, chat:<id>,
  editor:<id>, ...), or command:<id> for one of Work's commands. A row is
  highlighted when its url is what is in front, drags as that target (a chat
  as a chat, an open tab as itself, a page as a link), and shows what Work knows
  about it (a chat's live details on hover). An agent points at a row as
  sidebar:<label>, or by tab key when its url is an open tab. A row without url
  runs its source's open action, or opens and closes its children.
- icon: a Lucide name in PascalCase (Rocket), a chat glyph (<name>:<color>, e.g.
  rocket:blue), or an image address. Without one the url picks it (a favicon,
  a chat glyph).
- badges: strings or { label, icon }. signal: working (spinner), attention
  (needs the person), unread. activity: what the row is doing, on its icon's
  lower corner whatever the signal: working (spinner), or what it waits on,
  watch (eye), subagent (bot) or command (terminal); without it a working
  signal spins there. (A chat's own activity text, which chats rows carry
  in data, is a different thing.) progress: 0 through 1. trend: { values (up to
  60 readings from 0 through 1, oldest first), label? (the current reading,
  "12%"), tone? }, drawn as a sparkline at the row's end (chips draw it too). preview: { title,
  description, metadata: [{label, value}] up to six }. collapsed: false opens a
  row with children the first time it loads (sources start closed; static items
  start open unless collapsed: true).
- data is the record behind the row (never drawn), for code that reads it.

## Actions

Placements: actions (inline icon buttons, shown with the row's hover or focus),
menu (the overflow button; [] removes it), contextMenu (right-click; omit to
inherit menu, [] disables). Rows from a source carry their own; itemDefaults,
itemOverrides and section-level menu/contextMenu/actions replace them.
An entry is { label, action, icon?, url?, danger?, disabledReason?, input? }.
- Work's verbs work on any row: open, open-here, open-tab, open-side,
  open-floating, copy-url; refresh and search work on a section (search opens
  the palette scoped to its rows).
- Any other action is the source's own: lowercase words joined by dashes
  (archive, pin, toggle). The source receives it in action(). There is no run:
  prefix.
- url opens that target instead of running anything ("command:new-tab",
  "app:monitor"). Commands include new-tab, new-floating-chat, new-workflow,
  search-files, search-changes, remote-environment, server-members,
  server-secrets, server-connections (those not on offer here are hidden).
  A module's rows and action results may name only these; a layout's own
  header actions and items may name any of Work's commands.
- input asks first: { title?, submit?, fields: [{ name, label, value?,
  placeholder? }] } (one to four). The action receives values by field name;
  throw to keep the dialog open with your message.
- danger marks a destructive entry; a row's own danger entries come last,
  behind a rule.
headerActions are the section's own buttons, the same entries (itemId is "" in
action). The defaults are ordinary header actions: Tabs has New tab
(url "command:new-tab"), Workflows Create workflow, Files Find files
(url "command:search-files"), Bookmarks add and new-folder. [] removes them.

## Source modules

A module is a TypeScript file whose default export is the same contract Work's
own lists implement. Its path is relative to the project folder it runs in, so
put a section that names one in a project layer, beside the module (the shared
.work/workspace.js with the module committed, or the personal project file);
in the profile file it shows an error in every project without that file.
{ load, subscribe?, action?, move?, drop?, reveal? }. It runs in a lazy Bun
process, cwd the project root, with full filesystem, fetch, subprocess and npm
access and Work's Bun first on PATH. Local projects only; connected projects
keep apps. Every handler receives { projectRoot, signal, work, session? }.
- load({parentId, cursor, query?}) returns { items, cursor? }: one parent's
  page, at most 1000 rows, ids unique and stable (never positions). Throw on
  failure; old rows stay and Retry shows. query is set only for a palette mode
  with search "source".
- subscribe({projectRoot, invalidate}) returns cleanup; call invalidate when
  your data changes (watch the directory and filter the name, so atomic
  replacement is seen). An inactive view releases it; idle processes stop after
  30 seconds; editing the module restarts it.
- action({itemId, action, values?}) runs a row's or header's action; return
  { open: "<target>", mode? } to open something afterwards and { message } to
  say what happened in one sentence. Actions, moves and drops are serialized
  and reload the section.
- move({itemId, parentId, beforeId?}) makes rows draggable to reorder and
  reparent (beforeId absent means last). drop({parentId, beforeId?,
  payload:{kind, label, url?}}) takes pages, chats, bookmarks and other
  sections' rows. Only rows with hasChildren take "inside" drops, and rows with
  acceptsChildren while they hold none yet; a row never lands inside itself.
- reveal({url, after}) returns the row for something in front that no loaded
  page holds (shown past the loaded rows), or null.

work is Work, as the section grants it:
- work.read({source, parentId?, cursor?}) reads a page of one of Work's lists
  (bare name), in the same row shape, so you can filter, sort, group and pass
  rows through; needs collections: ["<name>"]. A section that read a list reads
  again whenever that list changes, so sorted rows follow live; rows that move
  slide to their new place.
- work.execute({source, itemId, action, values?}) runs a row's action as its
  menu would (archive a chat, close a tab); same grant.
- work.call({workflow, input?}) runs a project workflow and returns its output;
  needs workflows: ["<name>"]. This is how a module reaches secrets, company
  APIs through the gateway and brokered connections: the workflow holds them,
  under its own authorization and audit, and the module never does. A workflow
  that waits (a durable pause) is an error here.
work answers while the module serves a load or an action (not in subscribe),
eight calls at a time; waiting on Work does not count against the request's
own 30 seconds.
Modules never receive secrets or Work's server address. Committed project files
run with the project's own authority: review a module before trusting it.

Example: tabs in the sidebar, chats that need the person first, then working
ones, the rest in strip order. In the project's layer (copied from the resolved layout), replace
the Tabs section's source and grant tabs:
{ id: "tabs", title: "Tabs", source: ".work/tabs.ts", collections: ["tabs"],
  when: { tabPlacement: "sidebar" },
  headerActions: [{ label: "New tab", action: "open", icon: "Plus",
    url: "command:new-tab" }] }
.work/tabs.ts:
const rank = (row) =>
  row.signal === "attention" ? 0 : row.activity === "working" ? 1 : 2;
export default {
  async load({ work, parentId, cursor }) {
    const page = await work.read({ source: "tabs", parentId, cursor });
    if (parentId) return page;
    return { ...page, items: page.items
      .map((row, index) => ({ row, index }))
      .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
      .map(({ row }) => row) };
  },
  action: ({ work, itemId, action, values }) =>
    work.execute({ source: "tabs", itemId, action, values }),
};
Rows keep their url, so they still open, highlight and drag as tabs; close
reaches the tabs list through action. Omit move: a sorted list does not take
manual order. When a chat starts working its row slides up.

Example: a todo list over a file, with input and an inline action:
{ id: "todos", source: ".work/todos.ts", title: "Todos",
  headerActions: [{ label: "Add todo", action: "add", icon: "Plus",
    input: { title: "Add todo", fields: [{ name: "text", label: "Todo" }] } }] }
import { watch } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
const file = (root) => path.join(root, "todos.json");
const read = async (root) => {
  try {
    return JSON.parse(await readFile(file(root), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};
const save = async (root, todos) => {
  const temporary = file(root) + "." + crypto.randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(todos, null, 2));
  await rename(temporary, file(root));
};
export default {
  async load({ projectRoot, parentId }) {
    if (parentId) return { items: [] };
    return { items: (await read(projectRoot)).map((todo) => ({
      id: todo.id, label: todo.text,
      icon: todo.done ? "CircleCheck" : "Circle",
      actions: [{ action: "toggle", label: todo.done ? "Reopen" : "Complete",
        icon: "Check" }] })) };
  },
  subscribe({ projectRoot, invalidate }) {
    const watcher = watch(projectRoot, (event, name) => {
      if (event === "rename" || name?.toString() === "todos.json") invalidate();
    });
    return () => watcher.close();
  },
  async action({ projectRoot, itemId, action, values }) {
    const todos = await read(projectRoot);
    if (action === "add") {
      if (!values?.text?.trim()) throw Error("Write the todo first.");
      todos.push({ id: crypto.randomUUID(), text: values.text.trim(), done: false });
    } else if (action === "toggle") {
      const todo = todos.find((item) => item.id === itemId);
      if (!todo) throw Error("This todo is gone.");
      todo.done = !todo.done;
    } else throw Error("Unknown action");
    await save(projectRoot, todos);
  },
};

Example: beside a chat, what its agent records (agents set keys with
set_session_metadata):
{ id: "deploys", source: ".work/deploys.ts", title: "Deploys",
  when: { session: true } }
export default {
  async load({ session }) {
    return { items: (session?.metadata.deploys ?? []).map((deploy) => ({
      id: deploy.url, label: deploy.name, url: deploy.url, icon: "Rocket" })) };
  },
};
The section loads again when that chat's title or metadata changes. Its links
open as the chat's, and the palette does not search it.

Example: a company API behind the gateway, through a workflow. Write the
workflow with writing-workflows (its steps hold the secret or brokered
connection), save and deploy it (workflow-lifecycle), and have it return an
array of plain records. Name it as work:workflows lists it (its row id):
{ id: "tickets", title: "My tickets", source: ".work/tickets.ts",
  workflows: ["listTickets"] }
.work/tickets.ts:
export default {
  async load({ work, parentId }) {
    if (parentId) return { items: [] };
    const tickets = await work.call({ workflow: "listTickets",
      input: { mine: true } });
    return { items: tickets.map((ticket) => ({ id: ticket.id,
      label: ticket.title, description: ticket.status, url: ticket.url })) };
  },
};
A call waits for the workflow to finish (up to 100 seconds); one that pauses
is an error here. For an open HTTP API, fetch(url, { signal }) directly, check
response.ok, and return the API's next cursor. Never put credentials in rows.

## Chips

Chips sit above every chat's composer: what the chat holds, recorded and made.
chips: { source: "work:chips" } (the default) is Work's own chips for the chat:
the tabs it opened (pages, terminals, files, apps, workflows), its forks and
subagents, the app views its tools showed, the pull requests it recorded (wide,
with their live state, size, comments and checks when the person's GitHub
connection or GitHub CLI can read them), and the chips its agent attached. Past
three of a kind Work folds them into one group chip. Compact chips come first,
packed in lines; wide ones stack under them, against the composer. Past three
lines the rest fold behind "N more"; nothing scrolls sideways.

A chip is a row (above) with two more fields. wide: true spans the composer's
width with its description, badges and buttons in view; a compact chip shows its
icon and label, and its buttons come over its end under the pointer or keyboard
focus. tone (accent, success, warning, danger or info) colors its icon by what
it says (a pull request open, merged, failing), and a badge takes one too:
{ label, icon?, tone? }. A change of icon cross-fades and a change of tone
eases, so a chip that changes state reads as the same chip. url opens on click
with the open grammar (Cmd-click a new tab, Cmd-Shift-click to the side,
Option-click floating). actions are its buttons; menu or contextMenu its
right-click entries, after the open modes and before Customize chips. preview
is its hover card (false for none); without one, Work's chips show what they
stand for live. signal: working spins its icon; attention and unread dot it;
activity marks its icon's lower corner as on a row.
trend draws its sparkline after the label and badges, compact or wide, and on a
group's members. A chip with hasChildren is a group: a click opens its members upward. data is
the record behind it: Work's chips say what they are in data.kind
(pull-request, attached, browser, terminal, editor, chat, subagent, step, app,
workflow, mcpapp, group) and carry what their previews read. signal is one of
the three; attention outranks working.
Work's verbs need no label of their own: { action: "open-side" } is the
open-to-the-side button, and open-tab, open-floating and copy-url have theirs.
Work's remove is the X on the pages, terminals and files the chat opened (it
closes them), on recorded pull requests and on every attached chip (it takes
them off the chat); other chips of Work's have no X.

To rank, filter, group, restyle or add chips, write a module and name it:
chips: { source: ".work/chips.ts", collections: ["chips"], workflows: [...] },
in a project layer beside the module (the project's .work/workspace.js or the
personal project file; in the profile file it would fail in every project
without the module). It is a source module (below) with one
list to read: work.read({ source: "chips", parentId? }) gives the chat's chips
(the roots, or a group's members) and work.execute({ source: "chips", itemId,
action }) runs Work's actions on them. load receives the chat as session
{ id, title, metadata } and runs again when the chat's chips or metadata
change. Order is rank (the first chip is the first the keyboard reaches and the
last to fold). To group, give members parentId and add the group chip
({ id, label, icon, hasChildren: true, badges: [count] }) where it stands;
members may come in the same page or when load is asked for their parentId.
Your own chips take your own actions, which reach action(). A chips module runs
beside its chat, in whichever window shows it, so it reads no other Work list;
call a workflow (its workflows grant) for anything behind a credential.
Connected projects run no modules: their chats show Work's chips.

Agents attach chips without code: the session metadata key chips is a list of
chips (id: lowercase letters, digits, ".", "_" or "-", up to 64; label; and any
chip field but parentId and hasChildren: an attached chip stands at the root),
written with set_session_metadata; the list written without one removes it.
Work draws them among its own, always with an X that takes them off the chat,
and opens their url; an action of another name needs a chips module to run it.
A chips module sees them with data.kind attached, unless their data names a
kind, so an agent can give chips a kind the person's module styles, groups or
gives buttons.

Example: pull requests first, then a wide chip per deploy the agent recorded
under deploys, with a button that calls a workflow:
chips: { source: ".work/chips.ts", collections: ["chips"],
  workflows: ["redeploy"] }
.work/chips.ts:
const rank = (chip) => (chip.data?.kind === "pull-request" ? 0 : 1);
export default {
  async load({ work, parentId, session }) {
    const page = await work.read({ source: "chips", parentId });
    if (parentId) return page;
    const deploys = session?.metadata.deploys ?? [];
    return { items: [
      ...page.items
        .map((chip, index) => ({ chip, index }))
        .sort((a, b) => rank(a.chip) - rank(b.chip) || a.index - b.index)
        .map(({ chip }) => chip),
      ...deploys.map((deploy) => ({ id: "deploy-" + deploy.name,
        label: deploy.name, description: deploy.version, url: deploy.url,
        icon: "Rocket", wide: true, tone: deploy.healthy ? "success" : "danger",
        actions: [{ action: "redeploy", label: "Redeploy", icon: "RotateCw" },
          { action: "open-side" }],
        data: { kind: "deploy", name: deploy.name } })),
    ] };
  },
  async action({ work, itemId, action, values }) {
    if (action === "redeploy") {
      await work.call({ workflow: "redeploy",
        input: { name: itemId.slice("deploy-".length) } });
      return { message: "Redeploying." };
    }
    await work.execute({ source: "chips", itemId, action, values });
  },
};
Pass Work's actions through (the last line), so their X still works.

## App widgets

{ id: "monitor", app: "monitor", height: 320, collections: ["chats", "files"] }
draws a project app compact. collections grants Work's lists to it (bare names;
none by default). In the app use @catamorphic/app createHostCollection({source})
with the shared CollectionTree and runCollectionAction({source, itemId, action}),
subscribeDisplay for {mode, visible, surface}, and reportContentState for
availability. An app is for UI rows cannot express; prefer a module for lists.

## Palette modes

A palette mode is a typed name that scopes the command palette (Cmd+P, New Tab)
to one list: type the name then Space or Tab, or pick it from the @ list. Modes
live beside the sidebars, under palette.modes. Each takes exactly one of source
(work:<name> or a module path), section (a list section's id: its source or
items) or items:
{ id: "issues", trigger: "issues", aliases: ["bugs"], title: "Issues",
  icon: "Bug", source: ".work/issues.ts", search: "source" }
{ id: "changes", trigger: "changes", title: "Changes", source: "work:git" }
{ id: "todo", trigger: "todo", title: "Todos", section: "todos" }
{ id: "runbooks", trigger: "runbook", title: "Runbooks",
  items: [{ label: "Deploy", url: "https://wiki.example.com/deploy" }] }
A module mode takes collections and workflows grants like a section. Lists of
the chat in front (subsessions, session, when.session sections) have no chat in
the palette and are refused. A mode id shares the section id namespace. trigger
and aliases are 1 to 32 lowercase letters, digits or dashes, unique, and not a
built-in mode name (${[...RESERVED_PALETTE_TRIGGERS].join(", ")}). when accepts
permissions only. Rows use the row fields plus keywords; Enter opens a row's url
or runs its source's open action. search "palette" (default) loads rows once
and ranks them as the user types; search "source" passes what was typed to load
as query (debounced) for APIs that search server-side; only modules search.
topLevel: true also ranks a palette-searched mode's rows in the ordinary
palette; reserve it for small, frequent lists. Connected projects run no
modules, so module modes are hidden there.

## Designing good sections and modes

Choose by the question the user is asking. A section answers "what is going on"
and stays in view: current work, status, things needing attention. A mode
answers "take me to X" among many items: tickets, customers, runbooks. When both
apply, write one module and point a section and a mode at it.
- To change how one of Work's lists sorts, groups or filters, wrap it in a
  module with work.read and pass its rows through; never copy its data.
- Keep ids stable; put what the user types in label, where it lives or its
  state in description, synonyms in keywords.
- Give every row a destination (url) or an action that does what the label
  says. Never ship entries that silently do nothing.
- Keep load fast and bounded; cache slow APIs in the module and page with
  cursor.
After editing: read the winning file back, check its error banner, open both
sidebars, click and right-click rows, run each header action, change what is in
front, and check empty, loading, failed and retry states.
`;
