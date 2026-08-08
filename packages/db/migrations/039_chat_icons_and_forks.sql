-- Chat identity and lineage.
--
-- `icon`: agent-chosen icon for the conversation ("<name>:<color>", from
-- the host's curated set — like Linear's team icons). Null = the default
-- chat glyph.
--
-- `parent_session_id`: set on sessions forked from another conversation
-- (the fork carries the transcript up to the fork point and continues on
-- a tangent). ON DELETE SET NULL: a fork outlives its parent as a
-- standalone conversation.
ALTER TABLE agent_sessions
  ADD COLUMN icon varchar(80),
  ADD COLUMN parent_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL;

CREATE INDEX idx_agent_sessions_parent ON agent_sessions(parent_session_id);
