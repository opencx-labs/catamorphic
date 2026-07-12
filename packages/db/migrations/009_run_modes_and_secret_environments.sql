ALTER TABLE workflow_runs
  ADD COLUMN mode varchar(20),
  ADD COLUMN external_user_id varchar(255);

UPDATE workflow_runs
SET
  mode = CASE WHEN is_test THEN 'test' ELSE 'production' END,
  commit_sha = CASE WHEN is_test THEN NULL ELSE commit_sha END;

ALTER TABLE workflow_runs
  ALTER COLUMN mode SET NOT NULL,
  ALTER COLUMN commit_sha DROP NOT NULL,
  DROP COLUMN is_test,
  ADD CONSTRAINT chk_workflow_run_mode
    CHECK (mode IN ('test', 'production')),
  ADD CONSTRAINT chk_workflow_run_source
    CHECK (
      (mode = 'production' AND commit_sha IS NOT NULL)
      OR
      (mode = 'test' AND commit_sha IS NULL)
    );

CREATE INDEX idx_workflow_runs_mode
  ON workflow_runs(project_id, workflow_name, mode, created_at DESC);

ALTER TABLE project_secrets
  ADD COLUMN environment varchar(20) NOT NULL DEFAULT 'production',
  DROP CONSTRAINT project_secrets_pkey,
  ADD CONSTRAINT chk_project_secret_environment
    CHECK (environment IN ('test', 'production')),
  ADD PRIMARY KEY (project_id, environment, name);
