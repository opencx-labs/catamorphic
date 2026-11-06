-- Personal connections (ADR 0177). A member's own connection to a code host
-- (GitHub sign-in on the desktop, for example) belongs to no project: it
-- backs that person's repository import, sync, and pull requests in every
-- project they work in. Its authorization attempt names neither an
-- Environment alias nor a service connection.
ALTER TABLE connection_authorization_attempts
  ADD COLUMN personal boolean DEFAULT false NOT NULL;
ALTER TABLE connection_authorization_attempts
  DROP CONSTRAINT chk_connection_attempt_target;
ALTER TABLE connection_authorization_attempts ADD CONSTRAINT chk_connection_attempt_target
  CHECK (
    (service_connection_id IS NOT NULL)
    OR personal
    OR (project_id IS NOT NULL AND environment_name IS NOT NULL AND alias IS NOT NULL)
  );

-- One live personal connection per person and provider.
CREATE UNIQUE INDEX uq_connections_personal
  ON connections (tenant_id, owner_external_user_id, provider_kind)
  WHERE principal_kind = 'member' AND project_id IS NULL AND status <> 'revoked';
