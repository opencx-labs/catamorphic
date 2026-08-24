ALTER TABLE agent_sessions
  ADD COLUMN allocation_id uuid
    REFERENCES execution_allocations(id) ON DELETE SET NULL,
  ADD COLUMN environment_name text;

CREATE INDEX idx_agent_sessions_allocation
  ON agent_sessions(allocation_id)
  WHERE allocation_id IS NOT NULL;
