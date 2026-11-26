-- A checkout a sandbox may fetch (ADR 0353): one commit of one session's
-- copy, served over Git through the gateway to whoever presents the
-- token, until it is revoked or expires. The token is stored hashed, like
-- every grant.
CREATE TABLE workspace_checkouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    commit_sha varchar(64) NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX workspace_checkouts_expiry ON workspace_checkouts(expires_at);
