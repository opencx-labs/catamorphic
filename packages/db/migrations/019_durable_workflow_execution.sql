ALTER TABLE execution_jobs
  ADD COLUMN workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE CASCADE,
  ADD COLUMN boundary_attempt_id uuid,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN heartbeat_at timestamptz;

ALTER TABLE workflow_runs
  ADD COLUMN workflow_kind varchar(20) NOT NULL DEFAULT 'regular',
  ADD COLUMN state_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN current_boundary_index integer,
  ADD COLUMN cancel_reason text;

CREATE TABLE durable_run_states (
  run_id uuid PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  target_module_path text NOT NULL,
  target_export_name text NOT NULL,
  boundary_count integer NOT NULL CHECK (boundary_count > 0),
  current_boundary_index integer NOT NULL CHECK (current_boundary_index >= 0),
  current_input jsonb,
  active_invocation_id varchar(255),
  parent_run_id uuid REFERENCES workflow_runs(id) ON DELETE CASCADE,
  parent_boundary_attempt_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE durable_boundary_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  boundary_index integer NOT NULL CHECK (boundary_index >= 0),
  boundary_node_id varchar(255) NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  status varchar(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'canceled')),
  input jsonb,
  output jsonb,
  error text,
  retry_policy jsonb NOT NULL,
  invocation_id varchar(255) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (run_id, boundary_index, attempt)
);

ALTER TABLE execution_jobs
  ADD CONSTRAINT fk_execution_jobs_boundary_attempt
  FOREIGN KEY (boundary_attempt_id)
  REFERENCES durable_boundary_attempts(id) ON DELETE CASCADE;

CREATE TABLE durable_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  boundary_attempt_id uuid NOT NULL UNIQUE
    REFERENCES durable_boundary_attempts(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resumed', 'timed_out', 'canceled')),
  state_present boolean NOT NULL DEFAULT false,
  state jsonb,
  timeout_at timestamptz,
  resume_value jsonb,
  resume_idempotency_key varchar(255),
  resume_payload_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE durable_child_runs (
  parent_boundary_attempt_id uuid PRIMARY KEY
    REFERENCES durable_boundary_attempts(id) ON DELETE CASCADE,
  parent_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  child_run_id uuid NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'completed', 'failed', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_durable_pauses_due
  ON durable_pauses(timeout_at, id)
  WHERE status = 'open' AND timeout_at IS NOT NULL;

CREATE INDEX idx_durable_boundary_run
  ON durable_boundary_attempts(run_id, boundary_index, attempt);

CREATE INDEX idx_execution_jobs_workflow_run
  ON execution_jobs(workflow_run_id, status)
  WHERE workflow_run_id IS NOT NULL;

CREATE INDEX idx_execution_jobs_boundary_attempt
  ON execution_jobs(boundary_attempt_id, status)
  WHERE boundary_attempt_id IS NOT NULL;
