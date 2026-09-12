CREATE TABLE session_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  owner_external_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('app', 'workflow')),
  name text NOT NULL,
  title text NOT NULL,
  source_path text NOT NULL,
  source_paths jsonb NOT NULL DEFAULT '[]',
  remote_branch text NOT NULL,
  commit_sha text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discarded')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  discarded_at timestamptz,
  ref_deleted_at timestamptz,
  last_error text
);
CREATE INDEX session_artifacts_session ON session_artifacts(project_id, session_id);
CREATE UNIQUE INDEX session_artifacts_ref ON session_artifacts(project_id, remote_branch);
CREATE TABLE session_artifact_revisions (
  artifact_id uuid NOT NULL REFERENCES session_artifacts(id) ON DELETE CASCADE,
  commit_sha text NOT NULL,
  source_paths jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, commit_sha)
);

-- Existing temporary workflows become ordinary session artifacts. Their
-- immutable source identity is retained; no git operation occurs in migration.
INSERT INTO session_artifacts
  (id, project_id, session_id, owner_external_user_id, kind, name, title,
   source_path, source_paths, remote_branch, commit_sha, created_at, ref_deleted_at, status)
SELECT id, project_id, session_id, owner_external_user_id, 'workflow', workflow_name,
  workflow_name, source_path, jsonb_build_array(source_path), remote_branch,
  commit_sha, created_at, ref_deleted_at, CASE WHEN ref_deleted_at IS NULL THEN 'active' ELSE 'discarded' END FROM watchers;
INSERT INTO session_artifact_revisions (artifact_id, commit_sha, source_paths)
SELECT id, commit_sha, source_paths FROM session_artifacts;

ALTER TABLE apps ADD COLUMN session_artifact_id uuid REFERENCES session_artifacts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX apps_session_artifact ON apps(session_artifact_id) WHERE session_artifact_id IS NOT NULL;

-- Source identity follows every run (including child runs), so an ordinary
-- workflow name grant cannot expose another session's temporary results.
ALTER TABLE workflow_runs ADD COLUMN session_artifact_id uuid REFERENCES session_artifacts(id) ON DELETE SET NULL;
CREATE INDEX workflow_runs_session_artifact ON workflow_runs(session_artifact_id) WHERE session_artifact_id IS NOT NULL;
WITH RECURSIVE retained_runs AS (
  SELECT run.id, watcher.id AS artifact_id FROM workflow_runs AS run
  JOIN watchers AS watcher ON run.workflow_enablement_id = watcher.workflow_enablement_id
  UNION
  SELECT child.id, parent.artifact_id FROM workflow_runs AS child
  JOIN retained_runs AS parent ON child.parent_run_id = parent.id
)
UPDATE workflow_runs AS run SET session_artifact_id = retained.artifact_id
FROM retained_runs AS retained WHERE run.id = retained.id;
ALTER TABLE watchers DROP COLUMN ref_deleted_at;
