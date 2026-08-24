ALTER TABLE connection_authorization_attempts
  ADD COLUMN reauthorize_connection_id uuid
    REFERENCES connections(id) ON DELETE SET NULL;

CREATE TABLE connection_action_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_step_attempt_id uuid NOT NULL REFERENCES workflow_step_attempts(id) ON DELETE CASCADE,
  execution_job_id uuid NOT NULL REFERENCES execution_jobs(id) ON DELETE CASCADE,
  allocation_id uuid NOT NULL REFERENCES execution_allocations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  alias text NOT NULL,
  external_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT chk_connection_action_requirement_resolution
    CHECK (
      (status = 'pending' AND resolved_at IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_connection_action_requirements_pending_job
  ON connection_action_requirements(execution_job_id)
  WHERE status = 'pending';

CREATE INDEX idx_connection_action_requirements_resolution
  ON connection_action_requirements(
    tenant_id,
    project_id,
    environment_name,
    alias,
    external_user_id,
    status
  );

CREATE INDEX idx_connection_action_requirements_connection
  ON connection_action_requirements(connection_id, status);
