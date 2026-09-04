-- Durable provenance for the surface that first created a conversation.
-- It is presentation metadata, not an authorization boundary: every source
-- still creates an ordinary scoped agent session with the same access model.

ALTER TABLE agent_sessions
  ADD COLUMN source text NOT NULL DEFAULT 'api',
  ADD CONSTRAINT chk_agent_session_source CHECK (
    source IN ('desktop', 'mobile', 'slack', 'claude', 'mcp', 'api')
  );
