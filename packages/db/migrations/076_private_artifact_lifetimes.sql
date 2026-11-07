-- Immutable source pins cover project Git and private SHA-256 snapshots.
ALTER TABLE trigger_definitions DROP CONSTRAINT fk_trigger_binding_scan;
ALTER TABLE trigger_definitions ALTER COLUMN commit_sha TYPE text;
ALTER TABLE trigger_definition_scans ALTER COLUMN commit_sha TYPE text;
ALTER TABLE trigger_definitions ADD CONSTRAINT fk_trigger_binding_scan
  FOREIGN KEY (project_id, commit_sha) REFERENCES trigger_definition_scans(project_id, commit_sha) ON DELETE CASCADE;
ALTER TABLE deployment_artifacts ALTER COLUMN commit_sha TYPE text;
ALTER TABLE workflow_enablements ALTER COLUMN commit_sha TYPE text;

-- Retained source may belong to a member independently of a chat.
ALTER TABLE session_artifacts ADD COLUMN lifetime text NOT NULL DEFAULT 'session'
  CHECK (lifetime IN ('session', 'member'));
ALTER TABLE session_artifacts ADD CONSTRAINT member_artifact_lifetime CHECK (lifetime = 'session' OR (session_id IS NULL AND kind = 'workflow'));
ALTER TABLE session_artifacts ADD COLUMN workflow_enablement_id uuid
  REFERENCES workflow_enablements(id) ON DELETE SET NULL;
ALTER TABLE session_artifact_revisions ADD COLUMN remote_branch text;
ALTER TABLE session_artifact_revisions ADD COLUMN source_files jsonb;
UPDATE session_artifact_revisions AS revision
SET remote_branch = artifact.remote_branch
FROM session_artifacts AS artifact
WHERE revision.artifact_id = artifact.id AND revision.commit_sha = artifact.commit_sha;

-- Member documents use the same version journal, outside project file sync.
ALTER TABLE store_documents ADD COLUMN owner_external_user_id text NOT NULL DEFAULT '';
ALTER TABLE store_documents DROP CONSTRAINT store_documents_project_id_path_key;
ALTER TABLE store_documents ADD CONSTRAINT store_documents_owner_path_key
  UNIQUE (project_id, owner_external_user_id, path);

-- Host delivery is another durable destination for the existing event.
CREATE TABLE notification_host_deliveries (
  event_id uuid PRIMARY KEY REFERENCES user_notification_events(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX notification_host_deliveries_pending ON notification_host_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX notification_host_deliveries_expired ON notification_host_deliveries(lease_expires_at) WHERE status = 'leased';

CREATE UNIQUE INDEX private_artifacts_owner_name ON session_artifacts(project_id, owner_external_user_id, kind, name) WHERE lifetime = 'member' AND status = 'active';
