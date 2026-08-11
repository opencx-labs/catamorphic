-- Custom trigger kinds: workflows subscribe to host-defined trigger kinds
-- via `defineWorkflow(... { triggers: [trigger("kind", config)] })`. The
-- parser extracts bindings statically; these tables are the per-commit
-- projection of that extraction, so firing a trigger (a host request-path
-- operation) and listing bindings never re-parse project source.
--
-- `trigger_binding_scans` records that a (project, commit) pair has been
-- scanned and validated — including commits whose projects declare no
-- bindings at all, which would otherwise re-parse on every fire.
CREATE TABLE trigger_binding_scans (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha char(40) NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, commit_sha)
);

CREATE TABLE trigger_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  commit_sha char(40) NOT NULL,
  trigger_kind varchar(200) NOT NULL,
  workflow_name varchar(255) NOT NULL,
  -- Constant per-workflow config demanded by the kind (e.g. a tool
  -- description). Validated against the host kind's schema at scan time.
  config jsonb NOT NULL,
  -- Whether any execution path can leave the run waiting (pause, retry,
  -- rate limit, batch, child workflow). false = sync fire always completes.
  can_suspend boolean NOT NULL,
  -- ParameterInfo[] of the workflow input, for host introspection (e.g.
  -- building AI tool definitions) without a parse.
  input_parameters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_trigger_binding_scan FOREIGN KEY (project_id, commit_sha)
    REFERENCES trigger_binding_scans(project_id, commit_sha) ON DELETE CASCADE,
  CONSTRAINT uq_trigger_binding UNIQUE (project_id, commit_sha, trigger_kind, workflow_name)
);

CREATE INDEX idx_trigger_bindings_kind
  ON trigger_bindings(project_id, commit_sha, trigger_kind);
