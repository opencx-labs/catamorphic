-- Team automations (ADR 0156): a workflow enablement is owned by one member
-- or by the project's team. A team enablement runs as the project's team
-- principal, needs no connection to exist, and binds service connections
-- per alias like any other enablement.
ALTER TABLE workflow_enablements DROP CONSTRAINT chk_workflow_enablement_owner;
DROP INDEX uq_workflow_enablements_durable_owner;
ALTER TABLE workflow_enablements DROP CONSTRAINT workflow_enablements_owner_kind_check;
UPDATE workflow_enablements SET owner_kind = 'team' WHERE owner_kind = 'service';
ALTER TABLE workflow_enablements
  DROP COLUMN owner_connection_id,
  DROP COLUMN owner_principal_kind;
ALTER TABLE workflow_enablements
  ADD CONSTRAINT workflow_enablements_owner_kind_check
    CHECK (owner_kind IN ('member', 'team')),
  ADD CONSTRAINT chk_workflow_enablement_owner CHECK (
    (owner_kind = 'member' AND owner_external_user_id IS NOT NULL) OR
    (owner_kind = 'team' AND owner_external_user_id IS NULL)
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
