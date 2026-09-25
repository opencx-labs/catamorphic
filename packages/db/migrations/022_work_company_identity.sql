-- Company identity (ADR 0161): account lifecycle, rotating refresh token
-- families, and directory groups mapped to project roles.

-- One row per Work server user once the server has an opinion about it.
CREATE TABLE work_accounts (
    user_id text PRIMARY KEY,
    disabled_at timestamp with time zone,
    disabled_reason text,
    -- Last definitive answer from the upstream directory.
    directory_checked_at timestamp with time zone,
    directory_groups jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- A refresh token family starts at one authorization-code exchange and
-- rotates on every refresh. Reuse of a rotated token revokes the family.
CREATE TABLE work_token_families (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id text NOT NULL,
    client_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text
);

CREATE INDEX idx_work_token_families_user ON work_token_families USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE TABLE work_refresh_tokens (
    token_hash text PRIMARY KEY,
    family_id uuid NOT NULL REFERENCES work_token_families(id) ON DELETE CASCADE,
    -- The auth store's grant row holding this token pair.
    grant_id text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone
);

CREATE INDEX idx_work_refresh_tokens_family ON work_refresh_tokens USING btree (family_id);

-- `[{ "group": "eng@example.com", "roles": ["engineer"] }]`
ALTER TABLE work_project_admission_policies ADD COLUMN directory_roles jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Roles a directory mapping granted, so reconciliation removes only those.
CREATE TABLE work_directory_grants (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
