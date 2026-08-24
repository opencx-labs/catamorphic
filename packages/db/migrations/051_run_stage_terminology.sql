ALTER TABLE project_secrets
  RENAME COLUMN environment TO stage;

ALTER TABLE project_secrets
  RENAME CONSTRAINT chk_project_secret_environment TO chk_project_secret_stage;
