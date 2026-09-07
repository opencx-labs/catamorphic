CREATE TABLE client_runners (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  environment_name text NOT NULL,
  label text NOT NULL,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE client_runner_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id uuid NOT NULL REFERENCES client_runners(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  operation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ix_client_runner_jobs_pending ON client_runner_jobs(runner_id, created_at) WHERE status = 'pending';
