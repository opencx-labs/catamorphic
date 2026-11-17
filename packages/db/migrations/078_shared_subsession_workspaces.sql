-- A subsession that works in another session's workspace (ADR 0322): the
-- session whose Allocation, sandbox and session copy it uses. Null for a
-- session with a workspace of its own.
ALTER TABLE agent_sessions
  ADD COLUMN workspace_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL;
CREATE INDEX agent_sessions_workspace_session_idx
  ON agent_sessions(workspace_session_id)
  WHERE workspace_session_id IS NOT NULL;

-- The last setup run of an Allocation's workspace (ADR 0322): which build
-- (sandbox) it ran in and what it told its agent, so sessions that arrived
-- while it ran reuse its outcome instead of running it again.
ALTER TABLE execution_allocations ADD COLUMN setup_outcome jsonb;
