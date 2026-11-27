-- Hooks are triggers, and a hook may be waited for (ADR 0355).
--
-- waited: someone waits for the runs this event starts (a workspace's
-- setup). Each of its deliveries starts a run of its own, never joined to
-- a queued one alike it (ADR 0337), since its outcome is what is waited for.
ALTER TABLE project_events
  ADD COLUMN waited boolean NOT NULL DEFAULT false;

-- event_id: the Project Event whose delivery started this run. Only the
-- event dispatcher writes it; no caller's input, label or delivery key
-- reaches it. It is what a waited event's emitter finds its runs by, and
-- what lets the runs of a chat's setup event run commands in that setup.
-- It replaces the stamp a setup workflow's run carried (ADR 0324), which
-- named a workflow from configuration.
ALTER TABLE workflow_runs
  DROP CONSTRAINT chk_workflow_run_setup,
  DROP COLUMN setup_session_id,
  DROP COLUMN setup_build,
  ADD COLUMN event_id uuid;
CREATE INDEX idx_workflow_runs_event
  ON workflow_runs (event_id) WHERE event_id IS NOT NULL;
