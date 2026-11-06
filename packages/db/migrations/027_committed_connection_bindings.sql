-- Committed connection bindings and named service connections (ADR 0172).
-- Environments declare their connection aliases in `.work/project.json`;
-- the table that held them is gone. Service connections carry a name that
-- bindings resolve, and administrators authorize them through the
-- provider's ordinary challenge.

-- Grants and enablements name the alias they reach, not a binding row.
ALTER TABLE connection_capability_grants ADD COLUMN alias text;
UPDATE connection_capability_grants AS grant_row
   SET alias = binding.alias
  FROM environment_connection_bindings AS binding
 WHERE binding.id = grant_row.binding_id;
DELETE FROM connection_capability_grants WHERE alias IS NULL;
ALTER TABLE connection_capability_grants ALTER COLUMN alias SET NOT NULL;
ALTER TABLE connection_capability_grants DROP COLUMN binding_id;

ALTER TABLE workflow_enablement_connections DROP COLUMN binding_id;

DROP TABLE environment_connection_bindings;

-- Service connections are named: unique among live tenant connections, and
-- among live connections of one project. Member connections have no name.
ALTER TABLE connections ADD COLUMN name text;
UPDATE connections
   SET name = provider_kind || '-' || substr(id::text, 1, 8)
 WHERE principal_kind <> 'member';
ALTER TABLE connections ADD CONSTRAINT chk_connection_service_name
  CHECK ((principal_kind = 'member') = (name IS NULL));
CREATE UNIQUE INDEX uq_connections_tenant_service_name
  ON connections (tenant_id, name)
  WHERE principal_kind = 'tenant_service' AND status <> 'revoked';
CREATE UNIQUE INDEX uq_connections_project_service_name
  ON connections (project_id, name)
  WHERE principal_kind = 'project_service' AND status <> 'revoked';

-- An administrator's authorization of a named service connection has no
-- Environment or alias; a member's names both.
ALTER TABLE connection_authorization_attempts
  ADD COLUMN service_connection_id uuid REFERENCES connections(id) ON DELETE CASCADE;
ALTER TABLE connection_authorization_attempts ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE connection_authorization_attempts ALTER COLUMN environment_name DROP NOT NULL;
ALTER TABLE connection_authorization_attempts ALTER COLUMN alias DROP NOT NULL;
ALTER TABLE connection_authorization_attempts ADD CONSTRAINT chk_connection_attempt_target
  CHECK (
    (service_connection_id IS NOT NULL)
    OR (project_id IS NOT NULL AND environment_name IS NOT NULL AND alias IS NOT NULL)
  );

-- Work server organization administrators (ADR 0172): hold the host-issued
-- connections permissions. Project roles never grant them.
ALTER TABLE work_accounts ADD COLUMN administrator boolean DEFAULT false NOT NULL;
