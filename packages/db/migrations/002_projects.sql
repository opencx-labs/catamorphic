-- Drop old workflow-centric tables
DROP TABLE IF EXISTS workflow_run_steps CASCADE;
DROP TABLE IF EXISTS workflow_runs CASCADE;
DROP TABLE IF EXISTS workflows CASCADE;

-- Tenants
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(255) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Projects (replaces workflows as the primary entity)
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            varchar(255) NOT NULL,
  storage_type    varchar(20) NOT NULL DEFAULT 'managed',
  remote_url      text,
  default_branch  varchar(100) NOT NULL DEFAULT 'main',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_tenant_id ON projects(tenant_id);

-- Runs reference a project + workflow function name + exact commit
CREATE TABLE workflow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_name   varchar(255) NOT NULL,
  commit_sha      char(40) NOT NULL,
  status          varchar(50) NOT NULL DEFAULT 'pending',
  trigger_data    jsonb,
  result          jsonb,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_runs_project ON workflow_runs(project_id, workflow_name);
CREATE INDEX idx_workflow_runs_commit ON workflow_runs(project_id, commit_sha);

-- Run steps
CREATE TABLE workflow_run_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         varchar(255) NOT NULL,
  name            varchar(255) NOT NULL,
  status          varchar(50) NOT NULL DEFAULT 'pending',
  input           jsonb,
  output          jsonb,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz
);

CREATE INDEX idx_run_steps_run_id ON workflow_run_steps(run_id);
