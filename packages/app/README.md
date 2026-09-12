# @catamorphic/app

Guest runtime and host-themed UI components for sandboxed Catamorphic apps.

## Review components

Install the `code-review` source pack from the component registry and import the
local components. See [the registry](../registry/README.md) for installation and
adaptation. Review components are project source, not part of the guest runtime.

## App identity

`APP_ICON_NAMES`, `APP_ICON_DESCRIPTIONS`, and `resolveAppIcon` expose the
canonical semantic icon vocabulary. Hosts map these names to their icon library;
unknown values resolve to `default`. Agents use `set_app_presentation` to set a
title and/or icon without rebuilding. Every review uses `review`; uncertain
cases use `default`. Titles should be short and descriptive, with no required
template.


## Collections and trees

`createCollection({ source })` is a host-neutral, identity-indexed store. A source
implements `load({ parentId, cursor, signal })` and optionally
`subscribe(publish)`. Pages return `{ items, cursor? }`; each item has a stable
`id`, optional `parentId`, and `hasChildren` for unloaded branches. Changes are
`{ type: "upsert", items }`, `{ type: "remove", ids }`, or
`{ type: "invalidate", parentId? }`. Removal includes descendants. Refresh retains
loaded pages, push changes win over older in-flight snapshots, and concurrent
invalidations coalesce. Release the function returned by `acquire()` when done.
The last release detaches the source and aborts IO, retaining its snapshot.

The React exports from `@catamorphic/app/ui` are composable:

- `Tree`: virtual list/tree, stable expansion, keyboard navigation, selection,
  lazy disclosure, explicit row height and viewport size, arbitrary row renderer.
- `CollectionTree`: paged roots and lazy children over a collection, retry states,
  grouping and projection. Only expanded descendants are traversed. Its `active`
  prop owns the root and visible child leases; set it to the surface visibility.
- `useCollection`: topology subscription and acquisition; set `active: false`
  when the tree owns the lease. Set `projected: true` for observers whose counts
  or other derived state depend on item values. A hidden view can acquire
  `mode: "preview"` for first-page availability, using the same collection.
  Full owners restore the previously loaded depth.
- `useCollectionItem`: subscribe to one item without rebuilding the tree.
- `CollectionItemView`: label, icon, description, badges, progress, disclosure,
  preview and arbitrary child slots. `actions`, `menu` and `contextMenu` are
  independent placements of the same `ItemAction` callbacks. `contextMenu` defaults
  to `menu`; explicit `[]` disables it. Actions support pending and error states,
  a disabled reason, and danger styling.

Create stores once per source/scope, not per render. Item updates are batched in
one microtask. Topology notifications are separate; projected trees subscribe to
item snapshots so filtering, grouping and sorting stay current. Each visible tree
acquires its root and expanded branches; hiding or collapsing releases only its
own requests. Keep rows at their declared `rowHeight`;
put variable-size details in an overlay or separate pane. Virtual rows with an
active menu, inspector or editor may mark `data-interacting="true"` to remain
mounted. `shareEvent(connect)` lets multiple consumers share one event attachment.

Sandboxed apps can use `createHostCollection({ source })` for sources explicitly
granted by their host and `runCollectionAction({ source, itemId, action })` for
advertised capabilities. These carry no host credentials. Missing grants and
unsupported actions reject. Use `subscribeDisplay` for live surface and visibility
changes, and `reportContentState` for loading, empty, ready, error or unavailable.
Hosts implement the `AppCollections` broker and pass it to `AppMount`. They own
authorization, data adapters and action execution; no desktop identity is assumed.
