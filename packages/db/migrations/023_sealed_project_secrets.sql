-- Project secrets are sealed in the host's credential vault (ADR 0162). The
-- row keeps only the vault reference; `value` remains for hosts without a
-- vault and for rows written before sealing, which are sealed on first read.
ALTER TABLE project_secrets ADD COLUMN credential_ref text;
ALTER TABLE project_secrets ALTER COLUMN value DROP NOT NULL;
ALTER TABLE project_secrets ADD CONSTRAINT chk_project_secret_storage CHECK (((value IS NULL) <> (credential_ref IS NULL)));
