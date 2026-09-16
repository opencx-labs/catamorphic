# Executable local sidebar sources

A custom section can load live data using ordinary TypeScript:

```js
{
  id: "todos", type: "custom", title: "My todos",
  source: { type: "custom", module: ".catamorphic/todos.ts" },
  height: 280,
  headerActions: [{ label: "Refresh todos", action: "refresh", icon: "RefreshCw" }]
}
```

The module path resolves against the local project root; absolute paths also work.
The module runs in Bun in a separate process with that project as its working
directory. Filesystem, HTTP fetch, npm dependencies and subprocesses work normally.
No workflow deployment, generated sidebar snapshots, or app build is needed.
Remote-connected projects use host-authorized apps and collections instead.

Export a default object with `load({projectRoot,parentId,cursor,signal})` returning
`{items,cursor?}`. Items have stable `id` and `label`, optional `parentId` and
`hasChildren`, plus the usual sidebar icon, description, badges, progress, preview,
actions, overflow and context menu. Pages hold at most 1000 items. Return only the
requested parent's page. Pass `signal` into fetch and cancellable work. Never use
array positions as IDs. Reads must not mutate their data just because a view loads.

An optional `subscribe({projectRoot,invalidate})` returns a cleanup function.
Use it for file watchers or API refresh timers. Subscriptions are shared by visible
views of a source. Hidden views release them; `hideEmpty:true` keeps a root preview
lease so an empty section can discover new content. Keep that subscription light.
Closing the last view releases resources; idle processes stop after 30 seconds.
Editing the entry module reloads it. Refresh reloads data; imported-code changes
are picked up when the process next starts.

An optional `action({projectRoot,itemId,action,signal})` handles `run:<name>`
buttons and menus. Section header actions receive an empty itemId. Actions for a
shared source are serialized, then invalidate its collections. Throw an Error to
show a failed action beside the row. Use atomic replacement for file writes;
external writers can still race, so use a lock or transaction for shared data.

The native UI shows initial loading, retained rows during refresh, empty results,
read errors with Retry, and busy/error feedback on actions. Stable IDs preserve
focus and animate changed rows with the desktop's normal reduced-motion support.

## File-backed todos

Initialize `todos.json` with `[{"id":"plan","text":"Plan the week","done":false}]`.
Save the following as `.catamorphic/todos.ts`:

```ts
import { watch } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

type Todo = { id: string; text: string; done: boolean };
async function read(root: string): Promise<Todo[]> {
  return JSON.parse(await readFile(path.join(root, "todos.json"), "utf8"));
}
export default {
  async load({ projectRoot, parentId }) {
    if (parentId) return { items: [] };
    return { items: (await read(projectRoot)).map(todo => ({
      id: todo.id, label: todo.text,
      icon: todo.done ? "CircleCheck" : "Circle",
      description: todo.done ? "Completed" : undefined,
      actions: [{ action: "run:toggle", label: todo.done ? "Reopen" : "Complete", icon: "Check" }],
      menu: [{ action: "run:remove", label: "Delete", danger: true }],
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
    if (action !== "toggle" && action !== "remove") throw Error("Unknown todo action");
    if (!todos.some(todo => todo.id === itemId)) throw Error("This todo no longer exists");
    const next = action === "remove" ? todos.filter(todo => todo.id !== itemId)
      : todos.map(todo => todo.id === itemId ? { ...todo, done: !todo.done } : todo);
    const file = path.join(projectRoot, "todos.json");
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2));
    await rename(temporary, file);
  },
};
```

## HTTP list

The same contract supports pagination and writes to an API. Check response status,
use cancellation, and put any credentials in the source's normal environment or
credential store, never in row data sent to the renderer.

```ts
export default {
  async load({ cursor, signal, parentId }) {
    if (parentId) return { items: [] };
    const url = new URL("https://your-service.example/items");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Service returned ${response.status}`);
    const page = await response.json();
    return { items: page.items.map(item => ({
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

For a completely custom UI, continue to use an ordinary app widget with the public
collection and tree primitives. A source customizes data and actions while keeping
native row presentation, navigation, keyboard behavior and menus.
