CREATE TABLE active_run_invocations (
  invocation_id                    varchar(255) PRIMARY KEY,
  workflow_run_id                  uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_step_attempt_id         uuid,
  execution_job_id                 uuid NOT NULL REFERENCES execution_jobs(id) ON DELETE CASCADE,
  lease_token                      uuid NOT NULL,
  lease_generation                 bigint NOT NULL,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_active_run_invocation_step_attempt
    FOREIGN KEY (workflow_run_id, workflow_step_attempt_id)
    REFERENCES workflow_step_attempts(run_id, id)
    ON DELETE CASCADE,
  CONSTRAINT chk_active_run_invocation_lease_generation
    CHECK (lease_generation >= 0)
);

CREATE INDEX idx_active_run_invocations_run
  ON active_run_invocations(workflow_run_id, created_at);

CREATE INDEX idx_active_run_invocations_job
  ON active_run_invocations(execution_job_id);

INSERT INTO active_run_invocations (
  invocation_id,
  workflow_run_id,
  workflow_step_attempt_id,
  execution_job_id,
  lease_token,
  lease_generation
)
SELECT
  state.active_invocation_id,
  state.run_id,
  state.active_workflow_step_attempt_id,
  job.id,
  job.lease_token,
  job.lease_generation
FROM workflow_run_states AS state
CROSS JOIN LATERAL (
  SELECT candidate.*
  FROM execution_jobs AS candidate
  WHERE candidate.workflow_run_id = state.run_id
    AND candidate.workflow_step_attempt_id IS NOT DISTINCT FROM state.active_workflow_step_attempt_id
    AND candidate.status = 'running'
    AND candidate.lease_token IS NOT NULL
  ORDER BY candidate.heartbeat_at DESC, candidate.id
  LIMIT 1
) AS job
WHERE state.active_invocation_id IS NOT NULL;

-- Plain workflow runs used the running job attempt as their invocation ID and
-- did not have a workflow_run_states row.
INSERT INTO active_run_invocations (
  invocation_id,
  workflow_run_id,
  workflow_step_attempt_id,
  execution_job_id,
  lease_token,
  lease_generation
)
SELECT
  job.workflow_run_id::text || ':' || job.attempt::text,
  job.workflow_run_id,
  NULL,
  job.id,
  job.lease_token,
  job.lease_generation
FROM execution_jobs AS job
WHERE job.kind = 'workflow_run'
  AND job.status = 'running'
  AND job.lease_token IS NOT NULL
ON CONFLICT (invocation_id) DO NOTHING;

DROP INDEX uq_workflow_run_active_invocation;

ALTER TABLE workflow_run_states
  DROP CONSTRAINT chk_workflow_run_active_invocation,
  DROP COLUMN active_invocation_id;
