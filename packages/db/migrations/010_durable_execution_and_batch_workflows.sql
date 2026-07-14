CREATE TABLE deployment_artifacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha          char(40) NOT NULL,
  artifact_digest     char(64) NOT NULL,
  plugin_digest       char(64) NOT NULL,
  transform_version   varchar(100) NOT NULL,
  runtime_version     varchar(100) NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  ready_at            timestamptz,
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_deployment_artifact UNIQUE (project_id, artifact_digest),
  CONSTRAINT chk_deployment_artifact_status
    CHECK (status IN ('pending', 'building', 'ready', 'failed', 'retired'))
);

CREATE INDEX idx_deployment_artifacts_project_commit
  ON deployment_artifacts(project_id, commit_sha);

CREATE TABLE deployment_runtimes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id         uuid NOT NULL REFERENCES deployment_artifacts(id) ON DELETE CASCADE,
  provider_id         varchar(255) NOT NULL,
  replica_index       integer NOT NULL DEFAULT 0,
  generation          integer NOT NULL DEFAULT 1,
  status              varchar(20) NOT NULL DEFAULT 'creating',
  endpoint_metadata   jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at   timestamptz,
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_deployment_runtime
    UNIQUE (artifact_id, replica_index, generation),
  CONSTRAINT chk_deployment_runtime_status
    CHECK (status IN ('creating', 'starting', 'ready', 'draining', 'stopped', 'failed'))
);

CREATE INDEX idx_deployment_runtimes_ready
  ON deployment_runtimes(artifact_id, status, replica_index);

ALTER TABLE workflow_runs
  ADD COLUMN deployment_artifact_id uuid
    REFERENCES deployment_artifacts(id) ON DELETE RESTRICT,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN attempt integer NOT NULL DEFAULT 0;

CREATE TABLE execution_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind                varchar(50) NOT NULL,
  payload             jsonb NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  priority            integer NOT NULL DEFAULT 0,
  available_at        timestamptz NOT NULL DEFAULT now(),
  attempt             integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  leased_by           varchar(255),
  lease_expires_at    timestamptz,
  dedupe_key          varchar(500),
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT uq_execution_job_dedupe UNIQUE NULLS NOT DISTINCT (tenant_id, dedupe_key),
  CONSTRAINT chk_execution_job_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled'))
);

CREATE INDEX idx_execution_jobs_claim
  ON execution_jobs(status, available_at, priority DESC, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_execution_jobs_lease
  ON execution_jobs(lease_expires_at)
  WHERE status = 'running';

CREATE TABLE workflow_run_events (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence    integer NOT NULL,
  type        varchar(50) NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workflow_run_event_sequence UNIQUE (run_id, sequence)
);

ALTER TABLE workflow_run_steps
  ADD COLUMN occurrence integer NOT NULL DEFAULT 0,
  ADD COLUMN attempt integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT uq_workflow_run_step_occurrence
    UNIQUE (run_id, node_id, occurrence);

CREATE TABLE batch_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_name           varchar(255) NOT NULL,
  deployment_artifact_id  uuid REFERENCES deployment_artifacts(id) ON DELETE RESTRICT,
  mode                    varchar(20) NOT NULL,
  external_user_id        varchar(255),
  status                  varchar(30) NOT NULL DEFAULT 'pending',
  trigger_data            jsonb,
  source_snapshot         jsonb,
  source_cursor           jsonb,
  source_consistency      varchar(20),
  estimated_count         bigint,
  discovered_count        bigint NOT NULL DEFAULT 0,
  completed_count         bigint NOT NULL DEFAULT 0,
  failed_count            bigint NOT NULL DEFAULT 0,
  skipped_count           bigint NOT NULL DEFAULT 0,
  failure_policy          jsonb,
  cancel_requested_at     timestamptz,
  error                   text,
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_batch_run_mode CHECK (mode IN ('test', 'production')),
  CONSTRAINT chk_batch_run_status
    CHECK (
      status IN (
        'pending',
        'sourcing',
        'running',
        'sinking',
        'completed',
        'completed_with_errors',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT chk_batch_run_artifact
    CHECK (
      (mode = 'production' AND deployment_artifact_id IS NOT NULL)
      OR mode = 'test'
    )
);

CREATE INDEX idx_batch_runs_project
  ON batch_runs(project_id, workflow_name, created_at DESC);

CREATE TABLE batch_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_run_id      uuid NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  item_key          varchar(500) NOT NULL,
  source_order      bigint NOT NULL,
  status            varchar(20) NOT NULL DEFAULT 'pending',
  value             jsonb,
  value_reference   jsonb,
  output            jsonb,
  output_reference  jsonb,
  error             text,
  current_node_id   varchar(255),
  available_at      timestamptz NOT NULL DEFAULT now(),
  attempt           integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT uq_batch_item_key UNIQUE (batch_run_id, item_key),
  CONSTRAINT chk_batch_item_status
    CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'canceled')),
  CONSTRAINT chk_batch_item_value
    CHECK ((value IS NULL) != (value_reference IS NULL))
);

CREATE INDEX idx_batch_items_ready
  ON batch_items(batch_run_id, status, available_at, source_order)
  WHERE status IN ('pending', 'waiting');

CREATE INDEX idx_batch_items_status
  ON batch_items(batch_run_id, status);

CREATE TABLE batch_step_invocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_run_id        uuid NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  node_id             varchar(255) NOT NULL,
  compatibility_key   char(64) NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  attempt             integer NOT NULL DEFAULT 0,
  closes_at           timestamptz NOT NULL,
  started_at          timestamptz,
  completed_at        timestamptz,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_batch_step_invocation_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled'))
);

CREATE INDEX idx_batch_step_invocations_ready
  ON batch_step_invocations(status, closes_at, created_at)
  WHERE status = 'pending';

CREATE TABLE batch_step_members (
  invocation_id   uuid NOT NULL REFERENCES batch_step_invocations(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES batch_items(id) ON DELETE CASCADE,
  member_key      varchar(500) NOT NULL,
  input           jsonb,
  status          varchar(20) NOT NULL DEFAULT 'pending',
  output          jsonb,
  error           text,
  PRIMARY KEY (invocation_id, item_id),
  CONSTRAINT uq_batch_step_member_key UNIQUE (invocation_id, member_key),
  CONSTRAINT chk_batch_step_member_status
    CHECK (status IN ('pending', 'succeeded', 'failed', 'unresolved'))
);

CREATE TABLE batch_item_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES batch_items(id) ON DELETE CASCADE,
  node_id       varchar(255) NOT NULL,
  occurrence    integer NOT NULL DEFAULT 0,
  name          varchar(255) NOT NULL,
  status        varchar(20) NOT NULL,
  input         jsonb,
  output        jsonb,
  error         text,
  attempt       integer NOT NULL DEFAULT 1,
  started_at    timestamptz,
  completed_at  timestamptz,
  CONSTRAINT uq_batch_item_step_occurrence
    UNIQUE (item_id, node_id, occurrence),
  CONSTRAINT chk_batch_item_step_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'waiting'))
);

CREATE TABLE batch_sink_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_run_id    uuid NOT NULL REFERENCES batch_runs(id) ON DELETE CASCADE,
  chunk_key       varchar(500) NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'pending',
  first_order     bigint NOT NULL,
  last_order      bigint NOT NULL,
  item_count      integer NOT NULL,
  attempt         integer NOT NULL DEFAULT 0,
  acknowledgement jsonb,
  artifact        jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT uq_batch_sink_chunk UNIQUE (batch_run_id, chunk_key),
  CONSTRAINT chk_batch_sink_chunk_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX idx_batch_sink_chunks_ready
  ON batch_sink_chunks(batch_run_id, status, first_order);
