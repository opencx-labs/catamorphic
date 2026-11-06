-- Shares (ADR 0165): a document, folder, or app addressed to named people or
-- email domains outside the project. Viewers sign in; nothing is public.
CREATE TABLE work_shares (
    id text PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind text NOT NULL,
    -- A document path, a folder prefix, or an app name.
    target text NOT NULL,
    -- App shares: the Environment the app's workflows run in for viewers.
    environment text,
    title text NOT NULL,
    audience_emails jsonb DEFAULT '[]'::jsonb NOT NULL,
    audience_domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT work_shares_kind_check CHECK ((kind = ANY (ARRAY['document'::text, 'folder'::text, 'app'::text])))
);

CREATE INDEX idx_work_shares_project ON work_shares USING btree (project_id, created_at DESC);

-- Who opened what, and which app actions they took.
CREATE TABLE work_share_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    share_id text NOT NULL REFERENCES work_shares(id) ON DELETE CASCADE,
    viewer_user_id text NOT NULL,
    viewer_email text NOT NULL,
    action text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_work_share_events_share ON work_share_events USING btree (share_id, created_at DESC);
