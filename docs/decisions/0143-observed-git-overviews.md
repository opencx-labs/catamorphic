# 0143 — Observed Git overviews

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

Pure event delivery cannot guarantee recovery. Frequent polling remains simpler
but repeats unchanged work; use infrequent reconciliation instead. Filesystem
monitor configuration remains owned by the user, not silently enabled by the app.

## Consequences

External edits update promptly without continuous idle scans. Platform watcher
limits and missed events degrade to periodic reconciliation rather than stale
state forever. Tests must exercise real Git mutations, linked worktrees, burst
coalescing, failures, disposal, and renderer subscription races. Performance
reports distinguish Git scan counts and latency from whole-app CPU measurements.
