-- The project's own trigger kinds at a scanned commit, resolved to the host
-- kind that fires each and every filter along its chain (ADR 0326): a
-- workflow records events only of these. Commits scanned before this column
-- have none recorded and are refused until deployed again.
ALTER TABLE trigger_definition_scans
  ADD COLUMN project_kinds jsonb NOT NULL DEFAULT '[]'::jsonb;
