-- Mark runs triggered manually from the editor UI as test runs
ALTER TABLE workflow_runs
  ADD COLUMN is_test boolean NOT NULL DEFAULT false;
