-- A member's own agent asks Work for a link to connect an account (ADR 0316).
-- The offer names who may redeem it and for which alias; it is redeemed
-- once, in a browser signed in as that member. Only its hash is stored.
CREATE TABLE connection_connect_offers (
    token_hash text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_name text NOT NULL,
    alias text NOT NULL,
    external_user_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    redeemed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_connection_connect_offers_expiry
    ON connection_connect_offers (expires_at);

-- An attempt started from an offer completes only in the browser that
-- redeemed it: a forwarded upstream link cannot attach someone else's
-- account to the member who asked.
ALTER TABLE connection_authorization_attempts
    ADD COLUMN browser_binding_hash text;
