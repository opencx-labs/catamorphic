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

-- at_commit: the published commit an event is delivered at. Its emitter
-- reads the bindings of that revision and starts their runs there, so the
-- dispatcher, which delivers to each activation at its enablement's own
-- commit, leaves it alone. A deploy event is one (ADR 0355).
ALTER TABLE project_events
  ADD COLUMN at_commit char(40);

-- A revision's deploy is an event workflows bind (ADR 0355), not a workflow
-- the manifest names: the event recorded for the current try, and the
-- project automations that listen at the revision with the run each
-- started ([{ enablementId, workflowName, runId }]).
ALTER TABLE published_revisions
  ADD COLUMN deploy_event_id uuid,
  ADD COLUMN deploy_listeners jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A deploy the manifest named keeps the run it started: one under way while
-- this migration runs is still waited for, and earlier ones still report
-- theirs.
UPDATE published_revisions
SET deploy_listeners = jsonb_build_array(jsonb_build_object(
  'enablementId', deploy_enablement_id,
  'workflowName', deploy_workflow,
  'runId', deploy_run_id))
WHERE deploy_workflow IS NOT NULL
  AND deploy_enablement_id IS NOT NULL
  AND deploy_run_id IS NOT NULL;

-- One that had started no run yet starts over, as its revision's bindings
-- say: with nothing to wait for it would otherwise go live at once.
UPDATE published_revisions
SET status = 'pending',
    deploy_started_at = NULL,
    deploy_noticed = false,
    attempts = 0,
    retry_at = NULL,
    updated_at = now()
WHERE status = 'deploying'
  AND deploy_listeners = '[]'::jsonb;

ALTER TABLE published_revisions
  DROP COLUMN deploy_workflow,
  DROP COLUMN deploy_enablement_id,
  DROP COLUMN deploy_run_id;
