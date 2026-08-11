-- Workflow input/output JSON Schemas are extracted from source at parse time
-- (projection of the TS types). Persist them wherever workflow sets are
-- frozen, so tool definitions and validation never re-parse.

-- Trigger bindings gain the workflow's input schema (tool-definition-ready).
ALTER TABLE trigger_bindings
  ADD COLUMN input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN output_schema jsonb NOT NULL DEFAULT '{}'::jsonb;

-- App versions freeze the callable set's IO shapes next to the allowlist,
-- so the MCP tool surface serves real input schemas without a parse.
ALTER TABLE app_versions
  ADD COLUMN workflow_shapes jsonb;

-- Recorded scans predate the schema columns; drop them so the next fire or
-- list re-scans and fills the schemas in.
DELETE FROM trigger_binding_scans;
