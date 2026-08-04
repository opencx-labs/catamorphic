-- Multi-agent sessions. `agent_id` names the host-registered coding agent a
-- session runs on (a registry key owned by the host app; null = the host's
-- default agent). `model_effort` is a per-session reasoning-effort override
-- on the normalized low/medium/high scale. `system_prompt` preserves the
-- session's original system prompt so a session switched to another agent
-- can re-anchor its provider state faithfully.
ALTER TABLE agent_sessions
  ADD COLUMN agent_id varchar(255),
  ADD COLUMN model_effort varchar(20),
  ADD COLUMN system_prompt text;

ALTER TABLE agent_sessions
  ADD CONSTRAINT chk_agent_session_effort
  CHECK (model_effort IS NULL OR model_effort IN ('low', 'medium', 'high'));
