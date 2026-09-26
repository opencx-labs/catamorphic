-- Trigger filters and project trigger kinds (ADR 0171). A definition stores
-- the host kind it fires on, the filters every binding along a chain of
-- project kinds adds (all must match), and the project kind the workflow
-- named, for display. A workflow may bind one host kind several times
-- (two project kinds on one webhook), so definitions are keyed by their
-- position in the workflow's `triggers` list.
ALTER TABLE trigger_definitions
  ADD COLUMN where_filters jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN project_kind text,
  ADD COLUMN binding_index integer NOT NULL DEFAULT 0;

ALTER TABLE trigger_definitions DROP CONSTRAINT uq_trigger_binding;

-- Existing rows held at most one binding per kind and workflow; number them
-- so the new key holds for recorded scans.
UPDATE trigger_definitions AS definition
SET binding_index = numbered.position
FROM (
  SELECT id,
    (row_number() OVER (
      PARTITION BY project_id, commit_sha, workflow_name
      ORDER BY trigger_kind
    ) - 1)::integer AS position
  FROM trigger_definitions
) AS numbered
WHERE numbered.id = definition.id;

ALTER TABLE trigger_definitions
  ADD CONSTRAINT uq_trigger_definition
  UNIQUE (project_id, commit_sha, workflow_name, binding_index);
