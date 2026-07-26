-- Retention for finished runs.
--
-- Nothing purged finished work, so every table hanging off workflow_runs grew
-- without bound: a 100k-item batch with a five-node pipeline writes on the
-- order of 1.5M rows across batch_items, batch_item_steps, batch_step_members,
-- workflow_run_events, workflow_step_attempts, and execution_jobs. Run daily
-- that is hundreds of millions of rows a year, and every ON DELETE CASCADE in
-- the schema was unreachable because the root row was never deleted.
--
-- workflow_runs is that root: everything above cascades from it, so a single
-- bounded delete of terminal runs reclaims the whole tree.

-- Per-tenant override of the installation-wide window. Host-owned, like every
-- other column on this table: a tenant must not be able to extend its own
-- retention and grow shared storage without the host agreeing.
ALTER TABLE tenant_execution_policies
  ADD COLUMN retention_days integer;

ALTER TABLE tenant_execution_policies
  ADD CONSTRAINT chk_tenant_policy_retention_days
    CHECK (retention_days IS NULL OR retention_days > 0);

-- The sweep looks for terminal runs whose completed_at has aged out, oldest
-- first. Partial on the terminal statuses so the index holds only purgeable
-- rows and stays small relative to the table; live runs, which are the ones
-- read on every hot path, are excluded entirely.
--
-- project_id leads because the window is resolved per tenant and projects are
-- the join to a tenant, so a sweep for one tenant can seek rather than scan.
CREATE INDEX idx_workflow_runs_retention
  ON workflow_runs(project_id, completed_at)
  WHERE status IN ('completed', 'failed', 'canceled')
    AND completed_at IS NOT NULL;

-- A parent may reach a terminal status while a child run is still live (the
-- parent failed, the child had not yet been cancelled). Deleting the parent
-- would cascade onto that live child, so the sweep must skip any run with a
-- non-terminal descendant. This index makes that check a seek per candidate
-- rather than a scan of the children.
CREATE INDEX idx_workflow_runs_live_children
  ON workflow_runs(parent_run_id)
  WHERE parent_run_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'canceled');
