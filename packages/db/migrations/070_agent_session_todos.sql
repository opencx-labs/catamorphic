-- Session-scoped, agent-owned progress lists. The host exposes these as
-- read-only session state; only harness-neutral agent tools replace them.

ALTER TABLE agent_sessions
  ADD COLUMN todos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT chk_agent_session_todos_array CHECK (jsonb_typeof(todos) = 'array');
