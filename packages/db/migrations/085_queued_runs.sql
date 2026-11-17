-- ADR 0325: runs queue per correlation key, and delivery ids are their own key.
--
-- A `queued` run waits for the active run of its key to settle. It holds no
-- Allocation or job, so it is outside the active-key index; `queued_at` is
-- stamped under the key's advisory lock, so ordering by it is arrival order.
ALTER TABLE workflow_runs DROP CONSTRAINT chk_workflow_run_status;
ALTER TABLE workflow_runs ADD CONSTRAINT chk_workflow_run_status CHECK (
  status IN ('queued', 'pending', 'running', 'waiting', 'paused', 'canceling', 'completed', 'failed', 'canceled')
);
ALTER TABLE workflow_runs ADD COLUMN queued_at timestamp with time zone;
-- What starting a queued run needs that the run does not otherwise record:
-- the requested Environment, its enablement, and the commit it was asked at.
ALTER TABLE workflow_runs ADD COLUMN enrollment jsonb;
-- Starting a queued run that could not start yet: how often it was tried,
-- when last (for backoff), and whether it waits for room (woken when any run
-- settles) or after an error (failed after a bound). Its last error is `error`.
ALTER TABLE workflow_runs ADD COLUMN queue_attempts integer DEFAULT 0 NOT NULL;
ALTER TABLE workflow_runs ADD COLUMN queue_attempted_at timestamp with time zone;
ALTER TABLE workflow_runs ADD COLUMN queue_blocked character varying(10);
ALTER TABLE workflow_runs ADD CONSTRAINT chk_workflow_run_queue_blocked CHECK (
  queue_blocked IS NULL OR queue_blocked IN ('room', 'error')
);
ALTER TABLE workflow_runs ADD CONSTRAINT chk_workflow_run_queued CHECK (
  status <> 'queued' OR (queued_at IS NOT NULL AND correlation_key IS NOT NULL AND allocation_id IS NULL)
);

DROP INDEX uq_workflow_runs_correlation_active;
CREATE UNIQUE INDEX uq_workflow_runs_correlation_active ON workflow_runs
  USING btree (project_id, workflow_name, correlation_key)
  WHERE correlation_key IS NOT NULL
    AND status NOT IN ('queued', 'completed', 'failed', 'canceled');
CREATE INDEX idx_workflow_runs_queued ON workflow_runs
  USING btree (project_id, workflow_name, correlation_key, queued_at, id)
  WHERE status = 'queued';

-- One delivery (a webhook's id, a schedule occurrence, a project event)
-- starts at most one run of a workflow, whatever that run's status.
ALTER TABLE workflow_runs ADD COLUMN delivery_key character varying(500);
ALTER TABLE workflow_runs ADD CONSTRAINT chk_workflow_run_delivery_key CHECK (
  delivery_key IS NULL OR length(delivery_key) > 0
);
CREATE UNIQUE INDEX uq_workflow_runs_delivery ON workflow_runs
  USING btree (project_id, workflow_name, delivery_key)
  WHERE delivery_key IS NOT NULL;
