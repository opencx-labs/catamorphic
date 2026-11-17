-- Enablements follow the published program (ADR 0330); a project's deploy
-- workflow runs before they move, and host project cleanups are retried
-- until done (ADR 0331).

ALTER TABLE workflow_enablements
  ADD COLUMN follow boolean NOT NULL DEFAULT false,
  ADD COLUMN followed_sequence bigint;

-- Deploying by merging to main just works for what is already enabled.
UPDATE workflow_enablements
  SET follow = true
  WHERE temporary = false AND remote_branch = 'main';

-- Every published revision of a project, in publication order.
CREATE TABLE published_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigserial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha char(40) NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'deploying', 'applying', 'applied',
      'superseded', 'failed')),
  deploy_workflow text,
  deploy_enablement_id uuid REFERENCES workflow_enablements(id)
    ON DELETE SET NULL,
  deploy_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  previous_commit_sha char(40),
  error text,
  report jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX idx_published_revisions_project
  ON published_revisions(project_id, sequence DESC);
CREATE INDEX idx_published_revisions_open
  ON published_revisions(project_id, sequence)
  WHERE status IN ('pending', 'deploying', 'applying');
-- One revision per project deploys or applies at a time, on any replica.
CREATE UNIQUE INDEX uq_published_revisions_active
  ON published_revisions(project_id)
  WHERE status IN ('deploying', 'applying');

-- A host's project cleanup that has not reported done yet. The project is
-- gone, so the row keeps what the hook is told about it.
CREATE TABLE project_cleanups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  -- The hook's place among the host's project hooks.
  hook_index integer NOT NULL,
  project jsonb NOT NULL,
  identity jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, hook_index)
);

CREATE INDEX idx_project_cleanups_due ON project_cleanups(next_attempt_at);
