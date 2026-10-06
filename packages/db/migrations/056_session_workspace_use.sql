-- A person working in a chat's workspace beside its agent (ADR 0208), at a
-- terminal or through a preview, keeps it from being given back as idle,
-- as a turn does. Marked at most once a minute per chat.
CREATE TABLE session_workspace_use (
    session_id uuid PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    used_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Typing in a terminal is one such use; a terminal keeps no time of its own.
ALTER TABLE session_terminals DROP COLUMN used_at;
