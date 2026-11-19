-- The project store paths an enablement's owner consented to (ADR 0335):
-- what the workflow declares in `documents` at its commit, as
-- [{ "path": "store/…", "access": "read" | "write" }], a path ending in
-- "/" a folder. A project automation's runs reach exactly these; a
-- following enablement moves only to revisions these still cover.
ALTER TABLE workflow_enablements
  ADD COLUMN documents jsonb NOT NULL DEFAULT '[]'::jsonb;
