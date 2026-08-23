-- Human-readable, agent-published coordination status. Volatile running
-- state remains process-local; host-local checkout paths remain outside the
-- shared Catamorphic schema (ADR 0063).
ALTER TABLE agent_sessions
  ADD COLUMN activity varchar(500);
