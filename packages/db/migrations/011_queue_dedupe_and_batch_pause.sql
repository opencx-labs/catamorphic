ALTER TABLE execution_jobs
  DROP CONSTRAINT uq_execution_job_dedupe;

CREATE UNIQUE INDEX uq_execution_job_dedupe
  ON execution_jobs(tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE batch_runs
  ADD COLUMN paused_from_status varchar(30),
  DROP CONSTRAINT chk_batch_run_status,
  ADD CONSTRAINT chk_batch_run_status
    CHECK (
      status IN (
        'pending',
        'sourcing',
        'running',
        'paused',
        'sinking',
        'completed',
        'completed_with_errors',
        'failed',
        'canceled'
      )
    );
