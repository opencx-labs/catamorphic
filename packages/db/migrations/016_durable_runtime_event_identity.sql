ALTER TABLE workflow_run_events
  ADD COLUMN invocation_id varchar(255),
  ADD COLUMN attempt integer NOT NULL DEFAULT 1;

UPDATE workflow_run_events
SET invocation_id = run_id::text
WHERE invocation_id IS NULL;

ALTER TABLE workflow_run_events
  ALTER COLUMN invocation_id SET NOT NULL,
  DROP CONSTRAINT uq_workflow_run_event_sequence,
  ADD CONSTRAINT uq_workflow_run_event_sequence
    UNIQUE (invocation_id, sequence);

CREATE INDEX idx_workflow_run_events_run_sequence
  ON workflow_run_events(run_id, created_at, sequence);
