-- A subsession that works in another session's workspace (ADR 0322): the
-- session whose Allocation, sandbox and session copy it uses. Null for a
-- session with a workspace of its own.
ALTER TABLE agent_sessions
  ADD COLUMN workspace_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL;
CREATE INDEX agent_sessions_workspace_session_idx
  ON agent_sessions(workspace_session_id)
  WHERE workspace_session_id IS NOT NULL;
