-- A chat's wait for its workspace to be given back and made again in the
-- shape its agents need (ADR 0332), where every replica and restart reads
-- the same one. reshape_waiting_since: set once when something first
-- holds the workspace; the wait's deadline counts from it, for every
-- message waiting with it. reshape_look_at: when the chat looks again; its
-- due turns are moved to it. reshape_save_failures: saves in a row that
-- failed. All three clear once the workspace is given back, fits again,
-- or the wait fails.
ALTER TABLE agent_sessions
  ADD COLUMN reshape_waiting_since timestamp with time zone,
  ADD COLUMN reshape_look_at timestamp with time zone,
  ADD COLUMN reshape_save_failures integer NOT NULL DEFAULT 0;
