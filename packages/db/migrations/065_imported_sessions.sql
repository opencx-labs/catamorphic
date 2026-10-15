-- Sessions another tool ran, imported from its own transcript store
-- (ADR 0233): Claude Code or Codex, by its own session id. Null for
-- Work's own sessions. An imported session is read-only; one person has
-- at most one per project, tool and native session.
ALTER TABLE agent_sessions
    ADD COLUMN imported jsonb,
    ADD CONSTRAINT chk_agent_session_imported_object
        CHECK (imported IS NULL OR jsonb_typeof(imported) = 'object');

CREATE UNIQUE INDEX idx_agent_sessions_imported
    ON agent_sessions (
        project_id,
        external_user_id,
        (imported ->> 'harness'),
        (imported ->> 'nativeSessionId')
    )
    WHERE imported IS NOT NULL;
