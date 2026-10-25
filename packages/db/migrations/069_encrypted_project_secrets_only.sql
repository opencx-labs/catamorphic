-- Refuse unsupported plaintext records before dropping their storage column.
-- Never silently delete credentials during an alpha upgrade (ADR 0281).
ALTER TABLE project_secrets ALTER COLUMN credential_ref SET NOT NULL;
ALTER TABLE project_secrets DROP CONSTRAINT chk_project_secret_storage;
ALTER TABLE project_secrets DROP COLUMN value;
