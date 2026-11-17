-- Workflows run commands in a chat's workspace (ADR 0324).

-- A returned call that outlives its attempt waits like a pause: the call it
-- made, resolved as that call's result, and the key its follower ends it by.
ALTER TABLE workflow_pauses
  ADD COLUMN host_call jsonb,
  ADD COLUMN wait_key text,
  ADD CONSTRAINT chk_workflow_pause_host_call
    CHECK ((host_call IS NULL) = (wait_key IS NULL));
CREATE UNIQUE INDEX idx_workflow_pauses_open_wait_key
  ON workflow_pauses (wait_key) WHERE status = 'open' AND wait_key IS NOT NULL;

-- Where a running execution is: its sandbox, process and files.
ALTER TABLE session_actions ADD COLUMN progress jsonb;

-- The setup workflow Work runs for the chat while it runs: the secret its
-- run's correlation key carries, and how its commands may run. Then how
-- many workspaces the chat has had, and why the last one went away.
ALTER TABLE agent_sessions
  ADD COLUMN setup_run jsonb,
  ADD COLUMN workspace_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN workspace_released_reason text;
