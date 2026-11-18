-- ADR 0336: a queued run joins one of its key that waits for the same thing.
--
-- A workflow may declare `concurrency.coalesce`, paths into the run input
-- whose values say what a run is for (an event's kind, turn and status). A run
-- that would queue behind its key's runs, while one queued run of the same
-- owner and enablement has the same values, joins it instead of queuing
-- another, so a flood of alike events holds at most one waiting run. The run
-- that starts reads the state then, so it sees what every joined event said.
ALTER TABLE workflow_runs ADD COLUMN coalesce_key character varying(1000);
CREATE INDEX idx_workflow_runs_coalesce ON workflow_runs
  USING btree (project_id, workflow_name, correlation_key, coalesce_key)
  WHERE status = 'queued' AND coalesce_key IS NOT NULL;
