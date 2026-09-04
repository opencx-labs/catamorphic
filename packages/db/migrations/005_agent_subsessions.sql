-- First-class subsessions, delegation records, and per-user presentation
-- state (ADR 0090).

ALTER TABLE agent_sessions
  ADD COLUMN forked_from_session_id uuid;

ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_forked_from_session_id_fkey
  FOREIGN KEY (forked_from_session_id)
  REFERENCES agent_sessions(id)
  ON DELETE SET NULL;

CREATE INDEX idx_agent_sessions_forked_from
  ON agent_sessions(forked_from_session_id);

CREATE TABLE agent_session_views (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_user_id varchar(255) NOT NULL,
  visibility varchar(20) NOT NULL DEFAULT 'promoted',
  previous_visibility varchar(20) NOT NULL DEFAULT 'promoted',
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tenant_id, external_user_id),
  CONSTRAINT chk_agent_session_view_visibility
    CHECK (visibility IN ('latent', 'promoted', 'archived')),
  CONSTRAINT chk_agent_session_view_previous_visibility
    CHECK (previous_visibility IN ('latent', 'promoted')),
  CONSTRAINT chk_agent_session_view_archive
    CHECK ((visibility = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX idx_agent_session_views_navigation
  ON agent_session_views(tenant_id, external_user_id, visibility, updated_at DESC);

CREATE TABLE agent_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  target_session_id uuid NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
  route_id varchar(255) NOT NULL,
  task text NOT NULL,
  context_mode varchar(20) NOT NULL DEFAULT 'fresh',
  allow_further_delegation boolean NOT NULL DEFAULT true,
  status varchar(20) NOT NULL DEFAULT 'running',
  result_message_id uuid REFERENCES agent_messages(id) ON DELETE SET NULL,
  interrupted_by_external_user_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT chk_agent_delegation_context
    CHECK (context_mode IN ('fresh', 'inherit')),
  CONSTRAINT chk_agent_delegation_status
    CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'archived')),
  CONSTRAINT chk_agent_delegation_not_self
    CHECK (source_session_id <> target_session_id)
);

CREATE INDEX idx_agent_delegations_source_status
  ON agent_delegations(source_session_id, status, created_at DESC);
