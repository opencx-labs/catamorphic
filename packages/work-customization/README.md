# @catamorphic/work-customization

Work desktop customization contracts. This package has no Electron or core
imports. Generic paged collections and workflow clients come from
`@catamorphic/app`.

`CodeAccess` describes the package's `catamorphic.access` declaration;
`CODE_PERMISSIONS` lists host operations. Work's installed checker validates the
actual manifest along with the source and layout. `privateWorkflowAddress` parses
an exact `private:<artifactId>:<revision>` workflow address.

```ts
import type { SidebarSourceModule, WorkspaceConfig } from "@catamorphic/work-customization";

export default {
  async load({ session }) {
    return { items: [{ id: "context", label: session?.title ?? "My tasks" }] };
  },
  async action({ action, mode }) {
    if (action === "open") return { open: "file:tasks.md", mode };
  },
} satisfies SidebarSourceModule;

export const workspace = {
  sidebars: {
    left: [{ id: "tasks", title: "Tasks", sections: [{ id: "tasks", source: "./tasks/index.ts" }] }],
    right: [],
  },
} satisfies WorkspaceConfig;
```

`SidebarSourceModule` defines loading, subscriptions, actions, moving, dropping
and revealing rows. Each request has `projectRoot`, `work`, `signal`, and optional
current `surface` and `session`. Visibility predicates do not control which
context a source receives. `action: "open"` always carries its `mode` separately.
A returned `{ open, mode?, message? }` is a `SidebarSourceEffect`.

Rows use `SidebarSourceItem`; static rows use `SidebarItem`. `menu`, `contextMenu`
and `actions` are independent overflow, right-click and inline placements.
Absent `contextMenu` inherits the overflow menu; `[]` disables only that placement.
Presentation resolves from the row, then section `itemDefaults`, then its
`itemOverrides[id]`. Arrays replace rather than merge. There are no section-level
`menu`, `contextMenu`, `actions`, or `open` aliases. Section `headerActions` act on
the header.

`descriptionVisibility: "hover"` gives the label the description's space until
pointer hover or keyboard focus. `contextualIndicator: "row" | "icon" | "none"`
controls the indication on every row whose target matches the current surface;
the keyboard's focus ring remains independent.
