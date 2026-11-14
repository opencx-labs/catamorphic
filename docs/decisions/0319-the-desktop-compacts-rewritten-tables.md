# 0319: The desktop compacts the tables it rewrites

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

The desktop's embedded PGlite runs no autovacuum. Every update leaves the old
row version on disk, and every scan of the table reads past it, synchronously
on the Electron main process. A profile used daily for months held a 7.6 GB
database. Three tables made up 1.97 GB of it with under 6 MB of live data:
`agent_turn_attempts` (905 MB for 4 MB), the saved `workspace_states` (895 MB
for 122 kB) and `agent_sessions` (169 MB for 945 kB). Append-mostly tables
(events, items, native transcripts) stayed within 1.1 to 1.5 times their data.
Scanning the chat list took 40 to 196 ms instead of 3 to 5 ms.

PGlite does not keep `pg_stat_user_tables` dead-tuple counts, so a general
autovacuum-style policy has nothing to read. A plain `VACUUM` makes the space
reusable without returning it, and its first pass scans every page of every
table, which on a large profile would stall the main process for longer than
a rewrite of the bloated tables does.

## Decision

The desktop host keeps a short list of tables its own code rewrites in place
(`TableCompactor`, `apps/desktop/src/main/server/table-compaction.ts`). It
rewrites one with `VACUUM FULL` when the table's size with indexes and TOAST
exceeds both 16 MB and four times its size after its last rewrite. That size
is recorded in `desktop.table_compactions`, so a later launch does not rewrite
a table whose live data alone is past the floor. A rewrite that fails is
logged and recorded at the size it failed at: the other tables still run, and
it is not retried until the table grows that far again. One pass runs at boot,
after migrations and before windows read the tables, and then every 30
minutes; shutdown clears the timer before its slow steps. On the profile
above, the first pass took 1.3 s and later passes 3 ms.

A new table joins the list when measurement shows it rewritten in place.
Writers still avoid needless updates: the renderer no longer writes an
unchanged workspace snapshot.

Considered: a scheduled whole-database `VACUUM` (first pass too slow, space not
returned); compacting every table above a size (rewrites gigabytes of
append-mostly transcripts for nothing); moving PGlite off the main process
(addresses stalls generally but not disk growth, and is a larger decision of
its own).

## Consequences

Old profiles reclaim the space once, at the next launch after this change.
Tables stay within a small multiple of their live size, so their scans stay
short. Network Postgres hosts are unaffected: their server runs autovacuum.
The stock server's PGlite mode has the same gap for the shared `catamorphic`
tables and can adopt the same compactor when measured.
