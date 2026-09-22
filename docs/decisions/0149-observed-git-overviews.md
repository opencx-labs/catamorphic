# 0149 — Observed Git overviews

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Changes refreshed every 15 seconds even when the selected checkout was unchanged.
This repeats status and committed comparisons and delays external edits reaching
the UI. Issue #47 originally reported continuously scanning all known checkouts;
scoping removed that multiplier but not the recurring work.

## Decision

The desktop main process owns shared, scoped Git overview subscriptions. Only
visible consumers retain them. Filesystem notifications invalidate a snapshot;
Git remains the authority for its contents. Coalesce event bursts, serialize
reads, and retain the previous UI during refresh. Observe the selected working
trees and their actual Git directories, including linked-worktree shared refs.
Ignore Git object/log/lock churn and ignored untracked output. No Git configuration
is changed and no new watcher dependency is introduced.

Release watchers with the last consumer, on navigation, and on window destruction.
Reconcile every two minutes and on focus; rebuild watches during reconciliation
to recover from dropped events, errors, or replaced directories. Cache committed
comparisons by resolved HEAD/base object IDs, with cache lifetime bounded by the
subscription. Normal file edits do not rerun the same committed diff.

Watch what Git reports on, not the whole tree. Linux has no recursive watch
primitive: Node's recursive `fs.watch` walks the tree and takes one inotify
watch per directory, ignored trees included, against a per-user budget. On
Linux the monitor walks the tree itself and watches only directories outside
Git's ignore output (`node_modules/` and build output are never watched);
macOS and Windows keep one native recursive handle. New directories appear as
renames in their parent and trigger a rebuild; file renames (every editor's
atomic save) do not.

Bound the scan rate. Debouncing coalesces bursts but not a steady stream of
saves slower than the debounce, which would scan once per save. Each scan is
followed by a cooldown of four times its duration (at most five seconds), so
scanning never takes more than about a fifth of wall time, however fast an
agent edits. Single-edit latency is unaffected.

A section hidden for being empty keeps observing. Changes hides itself when
there is nothing to show (`hideEmpty` is its default), and a hidden section
used to release its subscription with it, so after a commit it could never
learn about the next edit. The tabbed sidebar now tells such a section it is
hidden only for being empty, and Changes keeps its subscription then. Apps and
other sections stay idle while hidden, as before.

Pure event delivery cannot guarantee recovery. Frequent polling remains simpler
but repeats unchanged work; use infrequent reconciliation instead. Filesystem
monitor configuration remains owned by the user, not silently enabled by the app.

## Consequences

External edits update promptly without continuous idle scans. Platform watcher
limits and missed events degrade to periodic reconciliation rather than stale
state forever. Tests must exercise real Git mutations, linked worktrees, burst
coalescing, failures, disposal, and renderer subscription races. Performance
reports distinguish Git scan counts and latency from whole-app CPU measurements.
