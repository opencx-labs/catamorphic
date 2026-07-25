ALTER TABLE execution_jobs
  ADD COLUMN exhaustion_handled_at timestamptz;

CREATE INDEX idx_execution_jobs_unhandled_exhaustion
  ON execution_jobs(completed_at, id)
  WHERE status = 'failed' AND exhaustion_handled_at IS NULL;

CREATE UNIQUE INDEX uq_workflow_runs_parent_step_child
  ON workflow_runs(parent_run_id, parent_workflow_step_attempt_id)
  WHERE parent_run_id IS NOT NULL
    AND parent_workflow_step_attempt_id IS NOT NULL;
