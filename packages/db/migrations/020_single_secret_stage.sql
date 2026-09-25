-- Secrets have one stage: the one runs read (ADR 0040 removed test runs).
-- A value saved only under the retired 'test' stage never reached a run, so
-- dropping those rows loses nothing a workflow could use.
DELETE FROM project_secrets WHERE stage <> 'production';
ALTER TABLE project_secrets DROP CONSTRAINT project_secrets_pkey;
ALTER TABLE project_secrets DROP CONSTRAINT chk_project_secret_stage;
ALTER TABLE project_secrets DROP COLUMN stage;
ALTER TABLE project_secrets ADD CONSTRAINT project_secrets_pkey PRIMARY KEY (project_id, name);
