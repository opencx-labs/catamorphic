-- ADR 0336: a queued run joins one of its key that waits for the same thing.
--
-- A workflow may declare `concurrency.coalesce`, paths into the run input
-- whose values say what a run is for (an event's kind, turn and status). A run
-- that would queue behind its key's runs, while one queued run of the same
-- owner and enablement has the same values, joins it instead of queuing
-- another, so a flood of alike events holds at most one waiting run. The run
-- that starts reads the state then, so it sees what every joined event said.
--
-- Each statement can run again: development profiles applied this file as
-- 091 before #457's reshape waits took 090.
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS coalesce_key character varying(1000);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_coalesce ON workflow_runs
  USING btree (project_id, workflow_name, correlation_key, coalesce_key)
  WHERE status = 'queued' AND coalesce_key IS NOT NULL;

-- A delivery that joined a queued run is that run's: a redelivery of it
-- returns the run instead of starting another (as `delivery_key` does for
-- the delivery that enrolled it). Cancelling the run ends every delivery
-- that joined it.
CREATE TABLE IF NOT EXISTS workflow_run_joins (
    project_id uuid NOT NULL,
    workflow_name character varying(255) NOT NULL,
    delivery_key character varying(500) NOT NULL,
    run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, workflow_name, delivery_key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_joins_run ON workflow_run_joins (run_id);

-- ADR 0336: every result a turn's agent submits counts toward the turn's
-- limit, accepted or refused, before it is checked.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS result_submissions integer NOT NULL DEFAULT 0;
