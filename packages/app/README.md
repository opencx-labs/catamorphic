# @catamorphic/app

Guest runtime and host-themed UI components for sandboxed Catamorphic apps.

## Feel shared with the host

Every guest document gets the host's focus behavior: one 2px accent ring from
the `--focus-ring-*` tokens, drawn only while the keyboard leads (the inline
runtime marks `data-focus-modality` on the root). The kit's checkbox and
select match the Work shell, and `Collapsible` is the same measured-height
primitive the shell uses, so apps agents build look and move like the rest of
the app by default (ADR 0168).

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
`{ type: "invalidate", parentId?, pages? }`. Removal includes descendants. Refresh
retains loaded pages, push changes win over older in-flight snapshots, and
concurrent invalidations coalesce (the widest wins); a `load()` asked for during
IO runs after it and resolves when it lands. The default refresh, `"loaded"`,
reads every loaded page again, never more reads than built them plus one, so a
filtering source cannot turn it into a read of the whole history.
`pages: "first"` suits a newest-first poll: it reads from the start only until
its rows meet the loaded ones and keeps the rest, so a poll costs one page at any
depth. Rows past the meeting point are not read again: pair it with a periodic
`"loaded"` refresh. It needs pages in one stable order, so filter in the source
and sort in the view (`project`). A branch reports `paging` while its next page is
read and `pageError` when that read failed, leaving its rows ready; a next page
asked for during a refresh runs after it. Release the function returned by `acquire()` when done.
The last release detaches the source and aborts IO, retaining its snapshot.

The React exports from `@catamorphic/app/ui` are composable:

- `Tree`: virtual list/tree, stable expansion, keyboard navigation, selection,
  lazy disclosure, explicit row height and viewport size, arbitrary row renderer.
  `indent` places each level's rows that far in, so a row's own box carries its
  indent. Keyboard focus draws one ring over the focused row's box, wholly
  inside it, that glides between rows (`[data-tree-focus]`). A host moves focus
  in with `focusTreeRow({ scroller, which: "first" | "last" | "selected",
  visible })` on the tree's `[data-tree-viewport]` (`onViewport` hands it over),
  and hears arrows past either end through `onTreeLeave({ container, onLeave })`
  to go on into a list beside it; the tree keeps those keys either way.
- `CollectionTree`: paged roots and lazy children over a collection, retry states,
  grouping and projection. A branch with more rows ends with three still
  placeholder rows; its next page is read once the person moves within a
  viewport of them. Each gesture (wheel, touch, a press, keyboard movement)
  allows three reads while each one moves the end down; a read that shows
  nothing new (a filter, a closed group) or a spent gesture leaves Show more
  instead, so a list never reads its whole history on its own. New rows arrive
  with the row motion, reads the person caused are announced politely, and a
  failed page ends the branch with its error and Retry (beside the tree, which
  owns only its items; Retry leaves focus on the last loaded row). Rows set as
  more than loaded say so (`aria-setsize="-1"`). `tail` shows root items known to
  come after the unloaded rows (an open item) past the end without reading up to
  them. `Tree` takes the same through `more` (a map of branch to `{ load,
  loading, error, next }`) and `tail`. Only expanded descendants are traversed. Its `active`
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
