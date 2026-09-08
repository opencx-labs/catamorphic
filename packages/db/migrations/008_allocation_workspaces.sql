-- A workspace belongs to its Allocation, not to a global provider/user pair.
-- Host-owned authoring sandboxes keep a null allocation_id.
ALTER TABLE project_sandboxes ADD COLUMN allocation_id uuid
  REFERENCES execution_allocations(id);
ALTER TABLE project_sandboxes DROP CONSTRAINT uq_dev_sandbox;
ALTER TABLE project_sandboxes DROP CONSTRAINT uq_exec_sandbox;
CREATE UNIQUE INDEX uq_dev_sandbox
  ON project_sandboxes (project_id, external_user_id)
  WHERE sandbox_type = 'dev' AND allocation_id IS NULL;
CREATE UNIQUE INDEX uq_exec_sandbox
  ON project_sandboxes (project_id, commit_sha)
  WHERE sandbox_type = 'execution' AND allocation_id IS NULL;
CREATE UNIQUE INDEX uq_project_sandboxes_allocation
  ON project_sandboxes (allocation_id) WHERE allocation_id IS NOT NULL;
