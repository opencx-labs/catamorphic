ALTER TABLE batch_step_invocations
  ADD COLUMN function_name varchar(255) NOT NULL,
  ADD COLUMN policy jsonb NOT NULL;

ALTER TABLE batch_runs
  ADD COLUMN sink_state jsonb,
  ADD COLUMN artifact jsonb,
  ADD COLUMN sink_completed_chunks bigint NOT NULL DEFAULT 0,
  ADD COLUMN sink_total_chunks bigint NOT NULL DEFAULT 0;
