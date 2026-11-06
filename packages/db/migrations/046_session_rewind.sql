-- A rollback rewinds a chat's files before it records the rollback (ADR
-- 0197): until then no turn of the chat starts, so nothing works on files
-- the log does not describe yet. Expires on its own if the rewinding host
-- went away.
ALTER TABLE agent_sessions ADD COLUMN rewind_until timestamp with time zone;
