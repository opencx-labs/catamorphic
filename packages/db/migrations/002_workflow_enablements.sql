-- The first post-release-baseline migration separates runtime authority from
-- workflow and trigger code projections
-- (ADR 0068). A definition is inert until an owner consents to an exact
-- deployment, Environment, and set of connections.

ALTER TABLE trigger_binding_scans RENAME TO trigger_definition_scans;
ALTER TABLE trigger_bindings RENAME TO trigger_definitions;

ALTER TABLE trigger_definitions
  DROP COLUMN environment_name,
  DROP COLUMN connection_authorization_snapshot;

CREATE TABLE workflow_enablements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_name varchar(255) NOT NULL,
  deployment_artifact_id uuid NOT NULL REFERENCES deployment_artifacts(id),
  commit_sha char(40) NOT NULL,
  remote_branch text NOT NULL DEFAULT 'main',
  environment_name text NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('member', 'service')),
  owner_external_user_id text,
  owner_connection_id uuid REFERENCES connections(id),
  owner_principal_kind text CHECK (
    owner_principal_kind IS NULL OR
    owner_principal_kind IN ('project_service', 'tenant_service')
  ),
  owner_identity jsonb NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_digest char(64) NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'disabled')),
  suspension_reason text,
  update_available boolean NOT NULL DEFAULT false,
  temporary boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_by_external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_workflow_enablement_owner CHECK (
    (owner_kind = 'member' AND owner_external_user_id IS NOT NULL
      AND owner_connection_id IS NULL AND owner_principal_kind IS NULL)
    OR
    (owner_kind = 'service' AND owner_external_user_id IS NULL
      AND owner_connection_id IS NOT NULL AND owner_principal_kind IS NOT NULL)
  )
);

CREATE INDEX idx_workflow_enablements_project_workflow
  ON workflow_enablements(project_id, workflow_name, created_at DESC);
CREATE INDEX idx_workflow_enablements_member
  ON workflow_enablements(tenant_id, owner_external_user_id, status)
  WHERE owner_kind = 'member';
CREATE INDEX idx_workflow_enablements_active
  ON workflow_enablements(project_id, commit_sha, status)
  WHERE status = 'active';
CREATE INDEX idx_workflow_enablements_deployment
  ON workflow_enablements(deployment_artifact_id);
CREATE UNIQUE INDEX uq_workflow_enablements_durable_owner
  ON workflow_enablements(
    project_id,
    workflow_name,
    environment_name,
    owner_kind,
    COALESCE(owner_external_user_id, ''),
    COALESCE(owner_connection_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE temporary = false;

CREATE TABLE workflow_enablement_connections (
  enablement_id uuid NOT NULL REFERENCES workflow_enablements(id) ON DELETE CASCADE,
  alias text NOT NULL,
  binding_id uuid NOT NULL REFERENCES environment_connection_bindings(id),
  connection_id uuid NOT NULL REFERENCES connections(id),
  provider_kind text NOT NULL,
  principal_kind text NOT NULL
    CHECK (principal_kind IN ('member', 'project_service', 'tenant_service')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enablement_id, alias)
);

CREATE INDEX idx_workflow_enablement_connections_connection
  ON workflow_enablement_connections(connection_id);

CREATE TABLE workflow_enablement_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enablement_id uuid NOT NULL REFERENCES workflow_enablements(id) ON DELETE CASCADE,
  trigger_definition_id uuid NOT NULL REFERENCES trigger_definitions(id) ON DELETE CASCADE,
  host_trigger_key text,
  config_overlay jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enablement_id, trigger_definition_id)
);

CREATE INDEX idx_workflow_enablement_triggers_definition
  ON workflow_enablement_triggers(trigger_definition_id, status);

CREATE TABLE workflow_enablement_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enablement_id uuid NOT NULL REFERENCES workflow_enablements(id) ON DELETE CASCADE,
  actor_external_user_id text,
  event_type text NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_enablement_events_enablement
  ON workflow_enablement_events(enablement_id, created_at DESC);

ALTER TABLE workflow_runs
  ADD COLUMN workflow_enablement_id uuid
    REFERENCES workflow_enablements(id) ON DELETE SET NULL;

CREATE INDEX idx_workflow_runs_enablement
  ON workflow_runs(workflow_enablement_id)
  WHERE workflow_enablement_id IS NOT NULL;

ALTER TABLE watchers
  ADD COLUMN workflow_enablement_id uuid
    REFERENCES workflow_enablements(id) ON DELETE SET NULL;

-- Existing schedules pointed directly at code projections. They cannot be
-- migrated safely because they have no owner consent, so recreate the empty
-- projection against explicit trigger activations.
DROP TABLE schedule_occurrences;
DROP TABLE schedule_bindings;

CREATE TABLE schedule_bindings (
  activation_id       uuid PRIMARY KEY REFERENCES workflow_enablement_triggers(id) ON DELETE CASCADE,
  cron_expression     varchar(255) NOT NULL,
  timezone            varchar(100) NOT NULL,
  next_fire_at        timestamptz NOT NULL,
  last_scheduled_for  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_bindings_due
  ON schedule_bindings(next_fire_at);

CREATE TABLE schedule_occurrences (
  activation_id       uuid NOT NULL REFERENCES schedule_bindings(activation_id) ON DELETE CASCADE,
  scheduled_for       timestamptz NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  run_ids             jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempt_count       integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  lease_owner         varchar(255),
  lease_expires_at    timestamptz,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  PRIMARY KEY(activation_id, scheduled_for),
  CONSTRAINT chk_schedule_occurrence_status CHECK (
    status IN ('pending', 'leased', 'enrolled', 'skipped', 'failed')
  )
);

CREATE INDEX idx_schedule_occurrence_claim
  ON schedule_occurrences(status, next_attempt_at, lease_expires_at);
