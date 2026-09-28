-- Personal credentials in a member's own sessions (ADR 0184). A member's
-- desktop sends their own harness logins (refresh tokens stripped) and
-- the files they listed for one project. Each value is sealed in the
-- credential vault; a row holds only its vault reference, a fingerprint,
-- and its size, one row per (tenant, project, member, kind, name).
CREATE TABLE personal_environment_entries (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    external_user_id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    credential_ref text NOT NULL,
    fingerprint text NOT NULL,
    bytes integer NOT NULL,
    expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (tenant_id, project_id, external_user_id, kind, name),
    CONSTRAINT personal_environment_entries_kind_check CHECK (
        kind = ANY (ARRAY['login'::text, 'file'::text])
    ),
    CONSTRAINT personal_environment_entries_login_check CHECK (
        kind <> 'login' OR name = ANY (ARRAY['claude-code'::text, 'codex'::text])
    )
);
