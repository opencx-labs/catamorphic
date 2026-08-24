CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  provider_kind text NOT NULL,
  principal_kind text NOT NULL
    CHECK (principal_kind IN ('member', 'project_service', 'tenant_service')),
  owner_external_user_id text,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'expired', 'revoked')),
  credential_ref text,
  account_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_connection_principal_owner CHECK (
    (principal_kind = 'member' AND owner_external_user_id IS NOT NULL)
    OR (principal_kind <> 'member' AND owner_external_user_id IS NULL)
  ),
  CONSTRAINT chk_connection_project_scope CHECK (
    (principal_kind = 'project_service' AND project_id IS NOT NULL)
    OR principal_kind <> 'project_service'
  )
);

CREATE INDEX idx_connections_tenant_principal
  ON connections(tenant_id, principal_kind, status);
CREATE INDEX idx_connections_expiry ON connections(expires_at)
  WHERE status = 'ready' AND expires_at IS NOT NULL;

CREATE TABLE environment_connection_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  alias text NOT NULL,
  provider_kind text NOT NULL,
  principal_kinds jsonb NOT NULL,
  service_connection_id uuid REFERENCES connections(id) ON DELETE SET NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, environment_name, alias)
);

CREATE TABLE member_connection_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  alias text NOT NULL,
  external_user_id text NOT NULL,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, environment_name, alias, external_user_id)
);

CREATE TABLE connection_authorization_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  alias text NOT NULL,
  provider_kind text NOT NULL,
  external_user_id text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  private_state_ref text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completing', 'completed', 'expired', 'canceled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_connection_auth_attempts_expiry
  ON connection_authorization_attempts(expires_at)
  WHERE status = 'pending';

CREATE TABLE connection_capability_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  allocation_id uuid NOT NULL REFERENCES execution_allocations(id) ON DELETE CASCADE,
  agent_session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES environment_connection_bindings(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  capabilities jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_connection_grants_expiry
  ON connection_capability_grants(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE connection_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  connection_id uuid REFERENCES connections(id) ON DELETE SET NULL,
  allocation_id uuid REFERENCES execution_allocations(id) ON DELETE SET NULL,
  actor_external_user_id text,
  event_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'error')),
  action text,
  arguments_digest text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_connection_audit_tenant_created
  ON connection_audit_events(tenant_id, created_at DESC);
