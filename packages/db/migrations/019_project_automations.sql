-- Project automations (ADR 0156): a workflow enablement is owned by one
-- member or by the project. A project enablement runs as the project
-- principal, needs no connection to exist, and binds service connections
-- per alias like any other enablement.
ALTER TABLE workflow_enablements DROP CONSTRAINT chk_workflow_enablement_owner;
DROP INDEX uq_workflow_enablements_durable_owner;
ALTER TABLE workflow_enablements DROP CONSTRAINT workflow_enablements_owner_kind_check;
UPDATE workflow_enablements SET owner_kind = 'project' WHERE owner_kind = 'service';
ALTER TABLE workflow_enablements
  DROP COLUMN owner_connection_id,
  DROP COLUMN owner_principal_kind;
ALTER TABLE workflow_enablements
  ADD CONSTRAINT workflow_enablements_owner_kind_check
    CHECK (owner_kind IN ('member', 'project')),
  ADD CONSTRAINT chk_workflow_enablement_owner CHECK (
    (owner_kind = 'member' AND owner_external_user_id IS NOT NULL) OR
    (owner_kind = 'project' AND owner_external_user_id IS NULL)
  );
CREATE UNIQUE INDEX uq_workflow_enablements_durable_owner
  ON workflow_enablements(
    project_id,
    workflow_name,
    environment_name,
    owner_kind,
    COALESCE(owner_external_user_id, '')
  )
  WHERE temporary = false;

-- One public endpoint per project webhook name. The token in its URL is the
-- sender's credential; workflows bind to the name with trigger("webhook").
CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- A workflow names a chat by id or by key (one deliver operation, ADR 0156):
-- the key is the chat's, not a "wake".
ALTER TABLE agent_sessions RENAME COLUMN wake_key TO chat_key;
ALTER INDEX uq_agent_sessions_active_wake_key
  RENAME TO uq_agent_sessions_active_chat_key;

-- Declared permissions (ADR 0158): a workflow names the project permissions
-- its runs need. An enablement records the set consented to; a run records
-- what its caller holds of the set, and host calls act with exactly that.
ALTER TABLE workflow_enablements
  ADD COLUMN permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workflow_runs ADD COLUMN caller_project_permissions jsonb;
