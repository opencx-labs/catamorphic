CREATE TABLE execution_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  binding_id text NOT NULL,
  workload_kind text NOT NULL
    CHECK (workload_kind IN ('agent', 'workflow')),
  root_workload_id uuid NOT NULL,
  worker_node_id text,
  policy_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT chk_execution_allocation_release
    CHECK (
      (status = 'active' AND released_at IS NULL)
      OR (status = 'released' AND released_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_execution_allocations_active_workload
  ON execution_allocations(workload_kind, root_workload_id)
  WHERE status = 'active';

CREATE INDEX idx_execution_allocations_project_environment
  ON execution_allocations(project_id, environment_name, status);

CREATE INDEX idx_execution_allocations_tenant_status
  ON execution_allocations(tenant_id, status);
