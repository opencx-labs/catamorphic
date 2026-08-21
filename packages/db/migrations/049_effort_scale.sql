-- The normalized reasoning-effort scale grows `xhigh` and `max` (ADR 0056):
-- the harnesses reach past `high` (Claude Code xhigh/max, Codex xhigh) —
-- "ultramode" is reasoning depth, and the session override must carry it.
ALTER TABLE agent_sessions
  DROP CONSTRAINT chk_agent_session_effort;

ALTER TABLE agent_sessions
  ADD CONSTRAINT chk_agent_session_effort
  CHECK (
    model_effort IS NULL
    OR model_effort IN ('low', 'medium', 'high', 'xhigh', 'max')
  );
