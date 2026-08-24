-- Trigger bindings are the enablement record for a deployed workflow. Freeze
-- the Environment and exact service connection ids selected while that
-- binding is first scanned. Dispatch must validate and reuse this snapshot.
ALTER TABLE trigger_bindings
  ADD COLUMN environment_name text,
  ADD COLUMN connection_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN connection_authorization_snapshot jsonb;

CREATE INDEX idx_trigger_bindings_environment
  ON trigger_bindings(project_id, environment_name)
  WHERE environment_name IS NOT NULL;

-- Existing projections predate authorization freezing. Rebuild them on the
-- next list or fire so they cannot be dispatched through the legacy path.
DELETE FROM trigger_binding_scans;
