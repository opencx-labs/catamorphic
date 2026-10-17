# Sidebar sources

Every list in a sidebar is a source (ADR 0234). A section names one: one of
Work's own lists (`source: "work:tabs"`), or a TypeScript module in the project
(`source: ".work/todos.ts"`). Work's lists are modules on the same contract as
yours, and one renderer draws every list, so anything a built-in list does, a
person's list can do too. The agent-facing contract, with every field and verb,
is `src/main/workspace-authoring.ts` (`WORKSPACE_AUTHORING_GUIDE`), which every
`workspace.js` starts with and the configuring-catamorphic-desktop skill embeds.
Keep this page and that guide in step.

| Part | Where |
|---|---|
| Layout validation, defaults, the one-time rewrite of old layouts | `src/main/workspace-config.ts`, `workspace-config-upgrade.ts` |
| The contract (rows, `work`, effects) | `src/shared/sidebar.ts`, `src/shared/sidebar-source.ts` |
| A module's Bun process and its `work` calls | `src/main/sidebar-source-runtime.ts`, `-worker.ts`, `-ipc.ts` |
| Work's lists | `src/renderer/sources/*` (registry, one file per family) |
| The one list renderer | `src/renderer/components/source-section.tsx` |
| A section's chrome, header actions, app and note sections | `src/renderer/components/sidebar-navigation.tsx` |

## Contract

```js
export default {
  load({ projectRoot, parentId, cursor, query, session, work, signal }) {}, // { items, cursor? }
  subscribe({ projectRoot, invalidate }) {},        // returns cleanup
  action({ itemId, action, values, session, work, signal }) {}, // { open?, mode?, message? }
  move({ itemId, parentId, beforeId, session, work, signal }) {},
  drop({ parentId, beforeId, payload, session, work, signal }) {},
  reveal({ url, after, session, work, signal }) {}, // a row past the loaded ones, or null
};
```

A module runs in a lazy Bun process with the project as its working directory,
full filesystem, fetch, subprocess and npm access, and Work's Bun first on
`PATH`. It runs only for local projects. `session` is the chat beside a
`when: { session: true }` section. Work's lists implement the same contract in
the window (sharing its caches) and take Work's live state from it.

Rows are one shape for everyone: `id`, `label`, `url` (any workspace target:
a page, a chat, `workflow:`, `app:`, `run:`, `file:`, an open tab's key,
`command:<id>`), `icon` (a Lucide name, `<chat icon>:<color>`, or an image
address), `description`, `badges` (strings or `{ label, icon }`), `signal`
(`working`, `attention`, `unread`), `progress`, `preview`, `collapsed`,
`menu`/`contextMenu`/`actions`, and `data` (the record behind the row, for code
that reads it). A row opens its `url`; it is active when that target is in front,
drags as that target, and gets Work's inspector for it (a chat's live details).

Actions: Work keeps `open`, `open-here`, `open-tab`, `open-side`,
`open-floating`, `copy-url`, `refresh` and `search`; any other name is the
source's. An entry with `input` asks for up to four values first. An action may
return `{ open, mode }` for Work to open and `{ message }` to say what happened.

What a source returns is held to what a row may do: its strings are bounded,
`data` crosses only up to 128 KB, and a `command:` it names (a row's `url`, a
menu entry's, an action's `open`) must be one that only opens something
(`new-tab`, `new-floating-chat`, `new-workflow`, `search-files`,
`search-changes`, `remote-environment`, `server-members`, `server-secrets`,
`server-connections`). A layout's own header actions and items may name any
command.

## Reaching Work, and anything else

`work` is Work as the section grants it:

- `work.read({ source, parentId, cursor })` reads one of Work's lists by its
  bare name, in the same row shape; `work.execute({ source, itemId, action,
  values })` runs a row's action. Both need the name in the section's
  `collections`. A section that read a list reads again when that list changes,
  so a sorted or filtered view follows live, and moved rows slide.
- `work.call({ workflow, input })` runs a project workflow and returns its
  output; it needs the name in `workflows`. Workflows hold secrets, gateway
  grants and brokered connections under their own authorization and audit, so
  this is how a module uses company APIs without ever holding a credential.
  The workflow must be deployed and finish within 100 seconds.

Main checks the grants against the resolved layout before asking the window,
and only the window that made the request answers it. `work` answers only
while the module serves a request (a load or an action, not `subscribe`),
eight calls at a time; time spent waiting on Work does not count against the
request's own 30 seconds.

## Sorted tabs

With tabs placed in the sidebar, the default Tabs section lists `work:tabs`.
Wrapping it sorts working and waiting chats first; rows slide as chats start
and stop. A module path resolves inside the project, so this goes in a project
layer beside the module (`.work/workspace.js` with the module committed, or the
personal project file), copied from the resolved layout:

```js
// .work/workspace.js
{ id: "tabs", title: "Tabs", source: ".work/tabs.ts", collections: ["tabs"],
  when: { tabPlacement: "sidebar" },
  headerActions: [{ label: "New tab", action: "open", icon: "Plus", url: "command:new-tab" }] }
```

```ts
// .work/tabs.ts
const rank = (row) => (row.signal === "attention" ? 0 : row.signal === "working" ? 1 : 2);
export default {
  async load({ work, parentId, cursor }) {
    const page = await work.read({ source: "tabs", parentId, cursor });
    if (parentId) return page;
    return {
      ...page,
      items: page.items
        .map((row, index) => ({ row, index }))
        .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
        .map(({ row }) => row),
    };
  },
  action: ({ work, itemId, action, values }) =>
    work.execute({ source: "tabs", itemId, action, values }),
};
```

## File-backed todos

Initialize `todos.json` with `[{"id":"plan","text":"Plan the week","done":false}]`
and add `{ id: "todos", source: ".work/todos.ts", title: "Todos" }`:

```ts
import { watch } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

type Todo = { id: string; text: string; done: boolean };
const file = (root: string) => path.join(root, "todos.json");
async function read(root: string): Promise<Todo[]> {
  return JSON.parse(await readFile(file(root), "utf8"));
}
export default {
  async load({ projectRoot, parentId }) {
    if (parentId) return { items: [] };
    return { items: (await read(projectRoot)).map((todo) => ({
      id: todo.id, label: todo.text,
      icon: todo.done ? "CircleCheck" : "Circle",
      actions: [{ action: "toggle", label: todo.done ? "Reopen" : "Complete", icon: "Check" }],
      menu: [{ action: "remove", label: "Delete", danger: true }],
    })) };
  },
  subscribe({ projectRoot, invalidate }) {
    const watcher = watch(projectRoot, (event, name) => {
      if (event === "rename" || !name || name.toString() === "todos.json") invalidate();
    });
    return () => watcher.close();
  },
  async action({ projectRoot, itemId, action }) {
    const todos = await read(projectRoot);
    if (!todos.some((todo) => todo.id === itemId)) throw Error("This todo no longer exists");
    const next = action === "remove"
      ? todos.filter((todo) => todo.id !== itemId)
      : todos.map((todo) => (todo.id === itemId ? { ...todo, done: !todo.done } : todo));
    const temporary = `${file(projectRoot)}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2));
    await rename(temporary, file(projectRoot));
  },
};
```

## HTTP list

Return a `cursor` while more rows exist: the section reads the next page as the
person scrolls near the end. Check response status, pass `signal`, and never
put credentials in rows (call a workflow for an API that needs them).

```ts
export default {
  async load({ cursor, signal, parentId }) {
    if (parentId) return { items: [] };
    const url = new URL("https://your-service.example/items");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Service returned ${response.status}`);
    const page = await response.json();
    return { items: page.items.map((item) => ({
      id: item.id, label: item.title, description: item.summary,
      url: item.url, icon: "FileText",
    })), cursor: page.nextCursor };
  },
  subscribe({ invalidate }) {
    const timer = setInterval(invalidate, 60_000);
    return () => clearInterval(timer);
  },
};
```

For UI rows cannot express, use an app section (`app`, with `collections` for
the Work lists it reads) and the public collection and tree primitives.

## Chips

A chat's chips are a source too (ADR 0239): workspace.js `chips: { source }`
names `work:chips` (the default) or a module that reads it with
`work.read({ source: "chips" })` and returns chips, with `collections:
["chips"]` and any `workflows`. A chip is a row plus `wide` and `tone`;
`hasChildren` makes a group whose members name it as `parentId`. Agents attach
chips under their session's `chips` metadata (`SESSION_CHIPS_CONTRACT`). The
contract and an example are in the authoring guide's Chips section.

| Part | Where |
|---|---|
| Validation of `chips`, the owner id it shares with sections | `src/main/workspace-config.ts`, `src/shared/workspace-config.ts` |
| Work's chips, built per chat | `src/renderer/lib/chips.ts` (rows), `src/renderer/app.tsx` (`chipsFor`, the chat's tabs), `src/renderer/components/chat-dock.tsx` (pull requests, attached chips, turns) |
| `work:chips` and a chips module's `work` calls, in the window that shows the chat | `src/renderer/lib/chip-board.ts`, `src/renderer/sources/chips.ts`, `src/renderer/lib/chips-work.ts`, `src/renderer/lib/use-chips.ts` |
| Pull request status (the person's connection, then the GitHub CLI) | `src/main/pr-status.ts`, `CodeHost.pullRequestStatus` |
| The rail: layout, folding, motion, keyboard, menus | `src/renderer/components/chip-rail.tsx`, `src/renderer/lib/chip-layout.ts` |
