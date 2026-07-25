ALTER TABLE durable_run_states
  ADD COLUMN boundary_descriptors jsonb NOT NULL DEFAULT '[]'::jsonb;
