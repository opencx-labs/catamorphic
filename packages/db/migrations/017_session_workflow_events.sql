-- Clock projections support finite one-shot schedules without inventing a second timer.
ALTER TABLE schedule_bindings ALTER COLUMN cron_expression DROP NOT NULL;
ALTER TABLE schedule_bindings ALTER COLUMN timezone DROP NOT NULL;
ALTER TABLE schedule_bindings ALTER COLUMN next_fire_at DROP NOT NULL;
ALTER TABLE schedule_bindings ADD COLUMN fire_at timestamptz;
ALTER TABLE schedule_bindings ADD CONSTRAINT schedule_binding_shape CHECK (
  (fire_at IS NOT NULL AND cron_expression IS NULL AND timezone IS NULL) OR
  (fire_at IS NULL AND cron_expression IS NOT NULL AND timezone IS NOT NULL)
);

-- A receipt belongs to an activation and event, including after its run settles.
CREATE TABLE project_event_deliveries (
  activation_id uuid NOT NULL REFERENCES workflow_enablement_triggers(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES project_events(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  run_ids jsonb NOT NULL DEFAULT '[]',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  error text,
  PRIMARY KEY (activation_id, event_id)
);
CREATE INDEX project_event_deliveries_due ON project_event_deliveries(status, next_attempt_at);

-- A session revision is distinct from authority fencing and transcript ordering.
ALTER TABLE agent_sessions ADD COLUMN state_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN work_status text NOT NULL DEFAULT 'open'
  CHECK (work_status IN ('open', 'completed'));


-- Event dispatch remains unique even if a worker loses its lease after a run settles.
CREATE UNIQUE INDEX workflow_runs_event_occurrence ON workflow_runs(workflow_enablement_id, correlation_key) WHERE correlation_key LIKE 'event:%';
