-- Workers own their lease (ADR 0192). A remote node's lease token is the
-- epoch its executor process chose at start, renewed by that process's own
-- calls to any replica. `remote` records what the executor offers
-- (`{"workspaceRoot": "/workspace", "processes": true}`), so any replica
-- builds the forwarding sandbox provider from this row. It is null for a
-- host's local node, whose sandboxes only that host process can reach.
ALTER TABLE worker_nodes ADD COLUMN remote jsonb;

-- Any replica saves an idle workspace or destroys a released one. It claims
-- the Allocation first under its own token until a time it renews while it
-- works, so two never do it at once, and a turn waits while it holds it.
ALTER TABLE execution_allocations ADD COLUMN maintenance_claim uuid;
ALTER TABLE execution_allocations ADD COLUMN maintenance_claimed_until timestamp with time zone;
