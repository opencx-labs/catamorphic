-- A session runs on one harness (ADR 0214). Its first turn binds the
-- harness, and an agent on another harness starts a new chat instead of
-- continuing this one. Sessions that already ran keep the harness of the
-- thread they ran on last. A mirrored copy holds its source's threads,
-- not its own: it binds on the first turn it runs (ADR 0197).
ALTER TABLE agent_sessions
    ADD COLUMN harness text;

UPDATE agent_sessions AS session
SET harness = (
    SELECT thread.harness
    FROM agent_provider_threads AS thread
    WHERE thread.session_id = session.id
    ORDER BY thread.updated_at DESC
    LIMIT 1
)
WHERE session.mirror_sequence = 0;
