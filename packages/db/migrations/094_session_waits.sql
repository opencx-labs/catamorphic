-- A wait its caller left running (ADR 0347): who waits on which chats,
-- from which log positions, and what the wait came to once a chat needed
-- them. An MCP task is one of these, so its id resolves on every replica
-- and its outcome, once reached, never changes. sessions: an array of
-- { projectId, sessionId, after? }. outcome: the answer the wait gave.
CREATE TABLE session_waits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_user_id varchar(255) NOT NULL,
    sessions jsonb NOT NULL,
    status text NOT NULL DEFAULT 'working',
    outcome jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT chk_session_wait_status CHECK (status IN ('working', 'completed', 'cancelled')),
    CONSTRAINT chk_session_wait_sessions CHECK (jsonb_typeof(sessions) = 'array')
);
CREATE INDEX session_waits_expiry ON session_waits(expires_at);
