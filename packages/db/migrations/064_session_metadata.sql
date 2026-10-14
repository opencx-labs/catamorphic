-- A session's metadata (ADR 0226): named JSON values agents and people set
-- on a chat and clients read, such as the pull requests it opened. One
-- object per session; core bounds its keys and size, and logs each change
-- as a session.changed event, so the column is the log's projection.
ALTER TABLE agent_sessions
    ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT chk_agent_session_metadata_object
        CHECK (jsonb_typeof(metadata) = 'object');
