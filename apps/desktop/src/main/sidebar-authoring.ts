/** One reference shared by the live config template and the project agent skill. */
export const SIDEBAR_AUTHORING_GUIDE = `## Sidebar: JavaScript, whole-document replacement

Use the supplied sidebar paths. Precedence is built-in, profile, shared project,
personal project. Each file replaces the entire document. Read the resolved highest
existing layer before copying it to a higher layer, then edit only the intended
sections. Preserve unrelated content. The profile file is the live, commented
schema/example; read it before editing. Export with module.exports = {left: [...],
right: [...]}. Delete an override file to inherit the lower layer again.
One left sidebar tab hides its tab strip; an empty right sidebar starts closed.
Sidebar content and the top/sidebar placement of open workspace tabs are separate.

Tabs and sections have stable id values. Keep an existing id through edits.
Every section selects a preset with type: workflows, apps, files, chats,
subsessions, tabs, bookmarks, git, prs, remote, activity, note, app or custom.
A custom section can reuse any built-in source:
{ id: "working", type: "custom", title: "Working chats",
  source: { type: "chats", filter: { running: true },
    sort: { field: "createdAt", direction: "desc" }, pageSize: 50 } }
For chats and subsessions, source.scope is project (default), children (current chat's immediate children),
or session (current chat). includeLatent includes unpromoted children when needed.
Filters compare authorized source fields to literal string, number or boolean values.
Use source.groupBy for collection grouping; sort uses {field,direction:"asc"|"desc"}.
pageSize is 1 through 100 for paged sources. Session roots and children load independently.
Filters and grouping apply to loaded source records; sorting orders loaded siblings.
Use a custom collection provider when ordering requires a server-side query over all records.

Relevance belongs on when, independently of permissions:
{ surface: ["chat"], session: true } shows beside a chat with a durable session.
Other conditions: pathPrefix, selection (boolean), builder, permissions.
Surface kinds include chat, editor, browser, terminal, workflow, app and diff.
These are current-content conditions; focusing the sidebar keeps its content target.
Subsessions defaults to current-chat children, including latent children, and hides
when empty. This does not promote a child or change archive behavior.
hideEmpty hides ready-but-empty content, not loading or errors. Parent tabs disappear
when every section is unavailable. Contextually hidden resources remain searchable.
Every section shares one status presentation: a header spinner while loading or
refreshing, placeholder rows before the first result, one muted sentence when empty
(section.empty replaces it), and the error with Retry. Sections never draw their own
loading or empty text; rows stay on screen while a refresh runs.

All row presentations accept label, icon (Lucide name), description, badges (strings),
progress (0 through 1), open (replace|tab|side|floating), preview and hide.
Use section.itemDefaults to customize all rows and itemOverrides keyed by stable
source item id for individual rows. Session ids are session UUIDs, file ids are
paths, app/workflow ids are names, PR ids are decimal PR numbers, bookmark ids are
store ids. Custom tree nodes should explicitly include id and may nest items.

Actions are separate placements, each an array of {label,action,icon?,url?,disabledReason?,danger?}:
- actions: inline icon buttons. Give every button a meaningful label and icon.
- menu: overflow button entries. [] removes the overflow button.
- contextMenu: right-click and Shift+F10 entries. Omit to inherit overflow; [] disables.
These work at section level, itemDefaults, itemOverrides and custom item level.
Action names include open, open-tab, open-here, open-side, open-floating, copy-url,
pin, unpin, edit, rename, remove, archive, unarchive, mark-read, mark-unread, stop,
fork, new-subsession, history, publish, new-chat, new-workflow, refresh and search. Only actions supported by the
source item are enabled. A static custom URL does not become an editable bookmark;
use the bookmarks source for bookmark mutations. A url on an action gives it its
own resource destination. Never configure an action that silently does nothing.
headerActions controls section header buttons; [] removes them. Header commands
are new-chat, new-workflow, search and refresh, or an explicit url destination.
rowHeight and height control collection density and viewport size.

Example contextual source with independent menus:
{ id: "delegated", type: "subsessions", title: "Delegated work",
  when: { surface: ["chat"], session: true }, hideEmpty: true,
  itemDefaults: {
    actions: [{label:"Open beside chat", action:"open-side", icon:"Columns2"}],
    menu: [{label:"Open in tab",action:"open-tab"}],
    contextMenu: [{label:"Open floating",action:"open-floating"},
                  {label:"Archive",action:"archive",danger:true}]
  } }

App widgets are ordinary project apps: {id:"monitor",type:"app",app:"monitor",
height:320,collections:["chats","files"]}. Collection grants support chats, subsessions,
activity, files, workflows, apps, git, prs, bookmarks, remote and tabs.
collections is an explicit host source
grant for this widget, never a permission bypass. Empty grants provide no sources.
Use @catamorphic/app createHostCollection({source:"chats"}) and the shared
@catamorphic/app/ui CollectionTree, CollectionItemView and useItemActions.
Create the collection once, e.g. with useMemo. CollectionTree pages roots, lazily
loads children, virtualizes rows and maintains identities. Use runCollectionAction
({source,itemId,action}) for a row's advertised actions. subscribeDisplay provides
live {mode,visible,surface}; unsubscribe in effect cleanup and pause expensive work
when hidden. reportContentState("loading"|"empty"|"ready"|"error"|"unavailable")
controls availability without unmounting the app. An app that reports empty must
retain a lightweight subscription so it can report ready when content arrives.
Pass display.visible to CollectionTree.active; the tree owns root and expanded
branch leases. For hidden availability, useCollection({collection,active:!display.visible,mode:"preview"})
refreshes only the first root page. The same hook observes content while the
visible tree owns full-depth leases. Never expand branches in preview mode.
For custom live data use createCollection({source:{load,subscribe}}). load receives
{parentId,cursor,signal} and returns {items,cursor?}. subscribe publishes upsert,
remove or invalidate changes and returns cleanup. Identity is stable; never use
array positions or JSON.stringify(item) as keys. No IPC callbacks or privileged
renderer JavaScript may be exported from sidebar.js.

After editing: read the actual winning file, validate the layout, check both sidebars,
try ordinary click and right-click separately, change the current surface, and
check empty/loading/error behavior. For new data, use a local executable source below, an app, or a supported source;
do not invent undocumented section types or fields.

## Executable local collection sources

For a live JSON/file/API list, keep the native sidebar UI and use:
{ id: "todos", type: "custom", title: "My todos",
  source: { type: "custom", module: ".catamorphic/todos.ts" }, height: 280 }
The module path is project-root-relative (absolute paths also work). Its default
export is {load, subscribe?, action?, move?, drop?}. This runs in a lazy Bun process with full
filesystem, fetch, subprocess and npm access, not inside the static layout VM.
Use normal TypeScript, not a data-source DSL. Local projects only; remote-connected
projects retain host-authorized app widgets. No app build or workflow is required.

load({projectRoot,parentId,cursor,signal}) returns {items,cursor?}. Items have unique
stable id and label, optional parentId/hasChildren and all normal row presentation
fields. Return one parent's page, at most 1000 items. Pass signal to fetch. Throw
an Error on failed responses; the sidebar retains old rows and offers Retry.
subscribe({projectRoot,invalidate}) returns cleanup. Use node:fs watch for files or
an interval for HTTP; close watchers and timers in cleanup. Watch the directory
and filter the filename so atomic file replacement is detected. An inactive view
releases its subscription. hideEmpty:true retains a root availability preview;
keep that work lightweight. Idle processes stop after 30 seconds. Entry-module
edits restart the process. Reads should not write as a side effect of rendering.

Example module:
import {watch} from "node:fs";
import {readFile,writeFile,rename} from "node:fs/promises";
import path from "node:path";
export default {
  async load({projectRoot,parentId}) {
    if(parentId) return {items:[]};
    const todos=JSON.parse(await readFile(path.join(projectRoot,"todos.json"),"utf8"));
    return {items:todos.map(todo=>({id:todo.id,label:todo.text,
      icon:todo.done?"CircleCheck":"Circle",
      actions:[{action:"run:toggle",label:todo.done?"Reopen":"Complete",icon:"Check"}]}))};
  },
  subscribe({projectRoot,invalidate}) {
    const watcher=watch(projectRoot,(event,name)=>{
      if(event === "rename" || !name || name.toString()==="todos.json") invalidate();
    });
    return ()=>watcher.close();
  },
  async action({projectRoot,itemId,action}) {
    if(action!=="toggle") throw Error("Unknown action");
    const file=path.join(projectRoot,"todos.json");
    const todos=JSON.parse(await readFile(file,"utf8"));
    const todo=todos.find(item=>item.id===itemId);
    if(!todo) throw Error("Todo no longer exists");
    todo.done=!todo.done;
    const temporary=file+"."+crypto.randomUUID()+".tmp";
    await writeFile(temporary,JSON.stringify(todos,null,2));
    await rename(temporary,file);
  }
};

Drag and drop is one model for every section, built in or custom, and needs no UI
code: export move({projectRoot,itemId,parentId,beforeId}) to let users reorder and
reparent this source's own rows by dragging (parentId null is the root; beforeId is
the sibling to land before, absent means last), and export drop({projectRoot,
parentId,beforeId,payload:{kind,label,url?}}) to accept pages, chats, bookmarks and
other sections' rows dragged in. Rows with a url can always be dragged out into
bookmarks or a chat. Both handlers are serialized with actions and invalidate the
view on success; throw for failures. Rows with hasChildren are the only "inside"
targets; everything else lands before or after a sibling. The tree draws the
insertion line and the highlighted parent the same way everywhere.

Initialize todos.json with an array of {id,text,done}. Agent edits and clicks now
share that file, with no sync script. Module actions use run:<name> in actions,
menu or contextMenu; headerActions can invoke them too (itemId is empty). Actions
are serialized per source and invalidate its loaded views on success. Throw for
failures; the UI shows pending and error states. For APIs, implement load with
fetch(url,{signal}), check response.ok, map response items to stable IDs/labels,
and return the API's next cursor. A subscribe interval must return clearInterval
cleanup. Do not pass credentials in row data. Validate loading, refresh, empty,
failed fetch, retry and action feedback in the app.
`;
