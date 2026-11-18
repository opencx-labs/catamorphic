-- An attempt's progress, stalls and restarts (ADR 0333).
--
-- progress_at: when the attempt last made progress (a runner frame other
-- than a diagnostic, or a model request the gateway admitted on its grant).
-- stall_after_seconds: its agent's stall threshold, copied when it starts;
-- null records no stall. stalled_at: set once per silence by the agent
-- worker, cleared by progress. diagnostics: the masked tails of the
-- runner's and the harness's own output, `{ runner, harness }`, dropped
-- when the attempt completes.
ALTER TABLE agent_turn_attempts
  ADD COLUMN progress_at timestamp with time zone,
  ADD COLUMN stall_after_seconds integer
    CHECK (stall_after_seconds IS NULL OR stall_after_seconds BETWEEN 60 AND 86400),
  ADD COLUMN stalled_at timestamp with time zone,
  ADD COLUMN diagnostics jsonb;

-- The attempts the agent worker checks for a stall.
CREATE INDEX agent_turn_attempts_stall_watch ON agent_turn_attempts (progress_at)
  WHERE status = 'running' AND stall_after_seconds IS NOT NULL AND stalled_at IS NULL;

-- A restart ends an attempt as `restarted` and runs the turn again with
-- reason `restart`, through a `restart` turn command.
ALTER TABLE agent_turn_attempts DROP CONSTRAINT agent_turn_attempts_reason_check;
ALTER TABLE agent_turn_attempts ADD CONSTRAINT agent_turn_attempts_reason_check
  CHECK (reason IN ('initial', 'retry', 'steer_restart', 'recovery', 'restart'));
ALTER TABLE agent_turn_attempts DROP CONSTRAINT agent_turn_attempts_status_check;
ALTER TABLE agent_turn_attempts ADD CONSTRAINT agent_turn_attempts_status_check
  CHECK (status IN ('preparing', 'running', 'completed', 'failed', 'interrupted',
                    'lost', 'superseded', 'restarted'));
ALTER TABLE agent_turn_commands DROP CONSTRAINT agent_turn_commands_kind_check;
ALTER TABLE agent_turn_commands ADD CONSTRAINT agent_turn_commands_kind_check
  CHECK (kind IN ('steer', 'interrupt', 'respond', 'release', 'stop', 'restart'));
