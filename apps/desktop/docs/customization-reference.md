# Work customization reference

The installed `@catamorphic/work-customization` types describe the running Work
version. `desktop_settings.authoring` identifies those declarations, this reference,
the exact host trigger declarations, and the checker/preview commands. No app build
or workflow is required for an ordinary list source.

## Layout and presentation

`workspace.js` is data-only CommonJS JavaScript. Its only top-level keys are
`sidebars`, optional `palette`, and optional `chips`. Workspace precedence is
built-in, profile, shared project, personal project; each file replaces the whole
lower document. The discovery response names the effective file and editable paths.

```js
// @ts-check
/** @satisfies {import('@catamorphic/work-customization').WorkspaceConfig} */
module.exports = {
  sidebars: {
    left: [],
    right: [{ id: 'tasks', title: 'Tasks', icon: 'ListTodo', sections: [
      { id: 'tasks-list', title: '', source: '.work/tasks/index.ts',
        itemDefaults: { contextualIndicator: 'icon' } }
    ] }]
  }
};
```

Tabs contain sections with exactly one of `source`, `items`, `app`, or `note`.
Source paths resolve against the owning project folder. Native lists use
`work:tabs`, `work:chats`, `work:files`, `work:bookmarks`, `work:pinned`,
`work:library`, `work:workflows`, `work:apps`, `work:subsessions`, `work:activity`,
`work:git`, `work:prs`, `work:remote`, `work:session`, or `work:resources`.
`work:chips` is a chat's composer chips. The public declarations list layout fields.

`when` controls visibility using surface kind, optional chat presence, path,
selection, tab placement or permissions. It grants no authority. Every source gets
authorized current-surface context and optional current-chat context independently.
Invalid conditions produce diagnostics. Stable IDs preserve row and section identity.

Row presentation precedence is source row, `itemDefaults`, then `itemOverrides[id]`.
There are no section-level `menu`, `contextMenu`, `actions`, or `open` aliases.
`headerActions` belongs to the section. Inline `actions`, overflow `menu`, and
right-click `contextMenu` are independent. Omitted context menus inherit overflow;
`[]` disables that placement. Arrays replace rather than merge.

Native rows are 28px tall. Sidebars are narrow, so short primary labels and quiet
defaults usually fit well. Rich `preview` details appear in the inspector.
`descriptionVisibility: 'hover'` shows secondary text on pointer hover or keyboard
focus, leaving the label the full row at rest. `contextualIndicator` is `row`,
`icon`, or `none`; every row whose URL matches the surface receives that indication,
independently of the single keyboard selection. `tone` colors the icon from the theme.
Routine successful actions return nothing; an optional effect message is explicit.

## Source contract

```ts
import type { SidebarSourceModule } from '@catamorphic/work-customization';

export default {
  async load({ parentId, work, surface }) {
    if (parentId) return { items: [] };
    const page = await work.read({ source: 'tabs' });
    return { ...page, items: page.items.map(row => ({
      ...row,
      descriptionVisibility: 'hover',
      contextualIndicator: 'icon',
    })) };
  },
  async action({ work, itemId, action, mode, values }) {
    await work.execute({ source: 'tabs', itemId, action, mode, values });
  },
} satisfies SidebarSourceModule;
```

The default export has `load` and optional `subscribe`, `action`, `move`, `drop`,
and `reveal`. Each handler receives `projectRoot`, `signal`, `work`, optional
`surface`, and optional `session`. Loads also receive `parentId`, optional `cursor`,
and a palette source's optional `query`. A page contains up to 1000 stable-ID rows
for one parent, plus an optional next cursor. A row can have children, URL, icon,
description, badges, progress, trend, signal, activity, preview, menus, and data.

A URL navigates through Work's normal resolver. A row without a URL receives
`action: 'open'` and a separate `mode` (`replace`, `tab`, `side`, `floating`). An
action may return `{ open, mode? }`. It receives `values` for an entry's `input`
dialog: `{ title?, submit?, fields: [{ name, label, value?, placeholder? }] }`, up to
four text fields. Thrown errors keep that dialog open with feedback.

`move({itemId,parentId,beforeId})` reorders or reparents this source's rows.
`drop({parentId,beforeId,payload})` accepts external rows. Root parent is null;
absent `beforeId` means last. `reveal({url,after})` can locate a current target past
loaded pages. Actions, moves and drops are serialized per source and invalidate it
on success. This does not serialize other writers to the same external file.

`subscribe({projectRoot,invalidate})` returns cleanup. A directory watch catches
atomic file replacement; a lightweight timer can represent changing external data.
Subscriptions end when unobserved. Imported helpers and the access manifest reload
with the entry module. Preview diagnostics expose the loaded revision and files.

## Access, state and execution

The nearest package manifest identifies one package's access. Its canonical
location, profile and project form the approval boundary. Equal or narrower reach
uses existing consent; broader reach asks again. These grants are enforced by
macOS Seatbelt or Linux Bubblewrap/seccomp, with no inherited credentials.

```json
{ "name": "tasks", "private": true, "catamorphic": { "access": {
  "lists": ["tabs"], "workflows": ["remind"],
  "permissions": ["state", "notifications", "processes", "background"]
} } }
```

`lists` names Work lists for `work.read` and `work.execute`. `workflows` names
authorized project workflows. `hosts` names permitted network destinations;
`reads` adds files outside the project; `writes` names files the package can change.
Modules cannot reach Work's protected listeners, keychain, clipboard, or other apps.
Work's own source, palette and chips renderers do not bypass this boundary.
On macOS, sources and managed commands run in one OS process: starting another
process is denied, including detached children. Managed commands replace their
launcher; `exec bun monitor.ts` is a single-process command. Linux contains process
trees in its PID namespace. Isolated workflows support multi-process logic and
ordinary npm tools on both platforms.

`work.state.read({key})` returns `{key,address,version,value}`, initially null at version 0.
`write({key,value,ifVersion})` and `delete({key,ifVersion})` reject stale versions.
Keys are member-private and confined to this package. Agents and workflows use the
canonical private-state service with the returned `address` as their explicit key. No file locks
are needed. Connecting a remote server does not upload this state.

`work.call({workflow,input})` waits for bounded work. `work.start({workflow,input})`
returns the same run handle as apps: `runId`, `poll()`, and `result({signal?})`.
`work.run({runId})` reopens a handle. Runs retain their normal authorization and
durable execution state; a view disappearing stops observation, not the run.
Shared workflows use their exported name. A member-private workflow uses
`private:<artifactId>:<revision>` in both the call and the package's `workflows`
declaration. The exact source revision is authorized; a shared workflow with
the same name does not grant access to a private run.

`work.notify({title,body?,route?,idempotencyKey})` records a durable notification
without a model turn. Routes are local host paths. Stable keys prevent a retried
operation from creating another event. OS banner display depends on user settings;
delivery transports are at least once and receive a stable event ID.

`work.processes.start({key,command,name?,lifetime})`, `list()`, `read({key,cursor?})`,
and `stop({key})` use the host's process provider. `view` lifetime ends with the
source; `application` requires background access and continues under Work's separate
background runtime after the UI quits. Services can restart after transfer or
failure. An OS process is not a durable workflow checkpoint. Resources and the
host background controls expose stop and inspect operations.
Native agents discover `work.processes.read` and `work.processes.write`.
Workflows declare `work.processes:read` or `work.processes:write` and call
`context.host['work.processes'].start/list/read/stop` with `sourcePath` selecting
the approved package entry. Both paths use application lifetime and still require
that package's signed `processes` and `background` access.

Private reusable workflows are member-lifetime retained artifacts. Their source
stays outside the project working tree and Git, pinned by an immutable snapshot
digest. Creation, source update, activation, and stopping are separate operations.
They use ordinary workflow enablements, scheduler and Runs; archiving the creating
chat does not stop them. The workflow-lifecycle and session-artifacts references
describe these host-neutral APIs and their consent/Environment requirements.

## Checking and preview

The installed checker accepts explicit hidden source paths, validates the real
layout, and checks against the installed SDK and host trigger declarations. It
does not run a project's check script. `--kind workflow` checks workflow source.
The preview capability runs the same worker, sandbox, declarations and row
validator as the live list. It reports access still requiring approval; it cannot
grant itself access. Fixture projects make interaction previews independent from
real user data. The retained eval scenarios exercise actual Codex agents and can
select Claude Code or the builtin harness through the same runner.

Existing customizations can use the [contract change notes](customization-migration.md).
