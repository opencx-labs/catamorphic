UPDATE durable_run_states
SET boundary_descriptors = '{"items":[]}'::jsonb
WHERE boundary_descriptors = '[]'::jsonb;

ALTER TABLE durable_run_states
  ALTER COLUMN boundary_descriptors
  SET DEFAULT '{"items":[]}'::jsonb,
  ADD CONSTRAINT chk_durable_boundary_descriptors_shape
  CHECK (
    jsonb_typeof(boundary_descriptors) = 'object'
    AND jsonb_typeof(boundary_descriptors -> 'items') = 'array'
  );
