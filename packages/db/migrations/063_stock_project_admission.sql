-- Stock-host admission policy. Authentication remains in Better Auth;
-- these rows decide how an authenticated user may become a project member.

CREATE TABLE stock_project_admission_policies (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (
    mode IN ('invitation_only', 'approved_domain', 'request', 'open')
  ),
  default_role text NOT NULL,
  approved_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by_external_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_project_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invited_email text,
  roles jsonb NOT NULL,
  grants jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_by_external_user_id text,
  redeemed_at timestamptz
);

CREATE INDEX idx_stock_project_invitations_project
  ON stock_project_invitations(project_id, created_at DESC);

CREATE TABLE stock_project_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by_external_user_id text,
  decided_at timestamptz
);

CREATE UNIQUE INDEX uq_stock_project_access_requests_pending
  ON stock_project_access_requests(project_id, external_user_id)
  WHERE status = 'pending';

CREATE INDEX idx_stock_project_access_requests_project_status
  ON stock_project_access_requests(project_id, status, requested_at DESC);
