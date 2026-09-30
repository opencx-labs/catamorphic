-- Workers own their lease (ADR 0192). A remote node's lease token is the
-- epoch its executor process chose at start, renewed by that process's own
-- calls to any replica. `remote` records what the executor offers
-- (`{"workspaceRoot": "/workspace", "processes": true}`), so any replica
-- builds the forwarding sandbox provider from this row. It is null for a
-- host's local node, whose sandboxes only that host process can reach.
ALTER TABLE worker_nodes ADD COLUMN remote jsonb;

-- Liveness is the node lease itself; the worker row no longer tracks it.
ALTER TABLE work_workers DROP COLUMN last_seen_at;

-- Any replica saves an idle workspace or destroys a released one. A replica
-- claims the Allocation until this time first, so two never do it at once.
ALTER TABLE execution_allocations ADD COLUMN maintenance_claimed_until timestamp with time zone;
