ALTER TABLE workflow_runs
  ADD COLUMN allocation_id uuid
    REFERENCES execution_allocations(id) ON DELETE SET NULL,
  ADD COLUMN environment_name text,
  ADD COLUMN caller_execution_scope jsonb,
  ADD COLUMN caller_connection_scope jsonb;

CREATE INDEX idx_workflow_runs_allocation
  ON workflow_runs(allocation_id)
  WHERE allocation_id IS NOT NULL;

ALTER TABLE deployment_runtimes
  ADD COLUMN binding_id text NOT NULL DEFAULT 'default',
  DROP CONSTRAINT uq_deployment_runtime,
  ADD CONSTRAINT uq_deployment_runtime
    UNIQUE (artifact_id, binding_id, replica_index, generation);

DROP INDEX idx_deployment_runtimes_ready;
CREATE INDEX idx_deployment_runtimes_ready
  ON deployment_runtimes(artifact_id, binding_id, status, replica_index);
