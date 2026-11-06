-- GitHub App registrations from a manifest in progress (ADR 0177). The
-- one-time link's state is the bearer, stored only as its hash, so any
-- replica continues a registration. Between GitHub creating the App and the
-- person installing it, the App's credentials are sealed in the credential
-- vault (`app_ref`); each browser leg claims its step once.
CREATE TABLE work_github_app_registrations (
    state_hash text PRIMARY KEY,
    tenant_id uuid NOT NULL,
    input jsonb NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    app_slug text,
    app_ref text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_github_app_registrations_status_check CHECK (
        status = ANY (ARRAY['pending'::text, 'converting'::text, 'created'::text, 'installing'::text])
    )
);
