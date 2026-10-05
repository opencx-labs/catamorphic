-- Terminals people open in a chat's workspace (ADR 0208). A terminal is a
-- background process of the workspace's sandbox and ends with it; this row
-- says whose it is, so only the person who opened it reads and types into
-- it, and when it was last used, so a workspace someone types in is not
-- given back as idle.
CREATE TABLE session_terminals (
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    process_id character varying(64) NOT NULL,
    -- The sandbox the process runs in: a terminal of an earlier workspace
    -- of the chat is gone.
    sandbox_id text NOT NULL,
    -- Its state directory under the session directory (`terminals/<key>`).
    terminal_key character varying(64) NOT NULL,
    external_user_id character varying(255) NOT NULL,
    pty boolean NOT NULL,
    opened_at timestamp with time zone NOT NULL DEFAULT now(),
    used_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, process_id)
);
