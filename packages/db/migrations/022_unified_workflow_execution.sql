-- ADR 0026 is a greenfield execution-model reset. Run and queue history is
-- intentionally discarded; project, deployment, plugin, secret, and sandbox
-- state remains untouched.
DROP TABLE IF EXISTS execution_jobs CASCADE;
DROP TABLE IF EXISTS batch_step_members CASCADE;
DROP TABLE IF EXISTS batch_item_steps CASCADE;
DROP TABLE IF EXISTS batch_sink_chunks CASCADE;
DROP TABLE IF EXISTS batch_step_invocations CASCADE;
DROP TABLE IF EXISTS batch_items CASCADE;
DROP TABLE IF EXISTS batch_execution_states CASCADE;
DROP TABLE IF EXISTS workflow_pauses CASCADE;
DROP TABLE IF EXISTS workflow_run_states CASCADE;
DROP TABLE IF EXISTS workflow_step_attempts CASCADE;
DROP TABLE IF EXISTS durable_child_runs CASCADE;
DROP TABLE IF EXISTS durable_pauses CASCADE;
DROP TABLE IF EXISTS durable_boundary_attempts CASCADE;
DROP TABLE IF EXISTS durable_run_states CASCADE;
DROP TABLE IF EXISTS batch_runs CASCADE;
DROP TABLE IF EXISTS workflow_run_events CASCADE;
DROP TABLE IF EXISTS workflow_run_steps CASCADE;
DROP TABLE IF EXISTS workflow_runs CASCADE;

CREATE TABLE workflow_runs (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_name                     varchar(255) NOT NULL,
  mode                              varchar(20) NOT NULL,
  provenance                        jsonb NOT NULL,
  deployment_artifact_id            uuid REFERENCES deployment_artifacts(id) ON DELETE RESTRICT,
  external_user_id                  varchar(255),
  status                            varchar(20) NOT NULL DEFAULT 'pending',
  phase                             varchar(20) NOT NULL DEFAULT 'execute',
  input                             jsonb,
  result                            jsonb,
  error                             text,
  state_version                     bigint NOT NULL DEFAULT 0,
  attempt                           integer NOT NULL DEFAULT 0,
  cancel_requested_at               timestamptz,
  cancel_reason                     text,
  parent_run_id                     uuid,
  parent_workflow_step_attempt_id   uuid,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  started_at                        timestamptz,
  completed_at                      timestamptz,
  CONSTRAINT uq_workflow_run_scope UNIQUE (id, project_id),
  CONSTRAINT chk_workflow_run_mode
    CHECK (mode IN ('test', 'production')),
  CONSTRAINT chk_workflow_run_status
    CHECK (
      status IN (
        'pending',
        'running',
        'waiting',
        'paused',
        'canceling',
        'completed',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT chk_workflow_run_phase
    CHECK (
      phase IN (
        'execute',
        'boundary',
        'source',
        'process',
        'sink',
        'pause',
        'child'
      )
    ),
  CONSTRAINT chk_workflow_run_provenance
    CHECK (
      jsonb_typeof(provenance) = 'object'
      AND (
        (
          mode = 'production'
          AND deployment_artifact_id IS NOT NULL
          AND provenance ? 'commitSha'
          AND jsonb_typeof(provenance -> 'commitSha') = 'string'
          AND length(provenance ->> 'commitSha') = 40
        )
        OR
        (
          mode = 'test'
          AND deployment_artifact_id IS NULL
        )
      )
    ),
  CONSTRAINT chk_workflow_run_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_workflow_run_attempt CHECK (attempt >= 0),
  CONSTRAINT chk_workflow_run_parent_link
    CHECK (
      (parent_run_id IS NULL AND parent_workflow_step_attempt_id IS NULL)
      OR
      (parent_run_id IS NOT NULL AND parent_workflow_step_attempt_id IS NOT NULL)
    ),
  CONSTRAINT chk_workflow_run_not_own_parent
    CHECK (parent_run_id IS NULL OR parent_run_id <> id),
  CONSTRAINT chk_workflow_run_completion
    CHECK (
      (status IN ('completed', 'failed', 'canceled') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed', 'canceled') AND completed_at IS NULL)
    )
);

CREATE INDEX idx_workflow_runs_project
  ON workflow_runs(project_id, workflow_name, created_at DESC);

CREATE INDEX idx_workflow_runs_deployment_artifact
  ON workflow_runs(deployment_artifact_id)
  WHERE deployment_artifact_id IS NOT NULL;

CREATE INDEX idx_workflow_runs_provenance_commit
  ON workflow_runs(project_id, (provenance ->> 'commitSha'))
  WHERE mode = 'production';

CREATE INDEX idx_workflow_runs_status
  ON workflow_runs(project_id, status, created_at DESC);

CREATE INDEX idx_workflow_runs_parent
  ON workflow_runs(parent_run_id, created_at)
  WHERE parent_run_id IS NOT NULL;

CREATE TABLE workflow_run_states (
  run_id                              uuid PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  execution_plan                      jsonb NOT NULL,
  current_step_index                  integer NOT NULL DEFAULT 0,
  current_input                       jsonb,
  active_workflow_step_attempt_id     uuid,
  active_invocation_id                varchar(255),
  operator_pause_previous_status      varchar(20),
  operator_pause_previous_phase       varchar(20),
  updated_at                          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_workflow_run_execution_plan
    CHECK (jsonb_typeof(execution_plan) = 'object'),
  CONSTRAINT chk_workflow_run_current_step CHECK (current_step_index >= 0),
  CONSTRAINT chk_workflow_run_active_invocation
    CHECK (
      active_invocation_id IS NULL
      OR active_workflow_step_attempt_id IS NOT NULL
    ),
  CONSTRAINT chk_workflow_run_operator_pause
    CHECK (
      (
        operator_pause_previous_status IS NULL
        AND operator_pause_previous_phase IS NULL
      )
      OR
      (
        operator_pause_previous_status IN (
          'pending',
          'running',
          'waiting',
          'canceling'
        )
        AND operator_pause_previous_phase IN (
          'execute',
          'boundary',
          'source',
          'process',
          'sink',
          'pause',
          'child'
        )
      )
    )
);

CREATE UNIQUE INDEX uq_workflow_run_active_invocation
  ON workflow_run_states(active_invocation_id)
  WHERE active_invocation_id IS NOT NULL;

CREATE TABLE workflow_step_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_index      integer NOT NULL,
  step_node_id    varchar(255) NOT NULL,
  executor        varchar(20) NOT NULL,
  attempt         integer NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'pending',
  input           jsonb,
  output          jsonb,
  error           text,
  policy          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  CONSTRAINT uq_workflow_step_attempt
    UNIQUE (run_id, step_index, attempt),
  CONSTRAINT uq_workflow_step_attempt_scope
    UNIQUE (run_id, id),
  CONSTRAINT chk_workflow_step_attempt_index CHECK (step_index >= 0),
  CONSTRAINT chk_workflow_step_attempt_executor
    CHECK (executor IN ('boundary', 'batch')),
  CONSTRAINT chk_workflow_step_attempt_number CHECK (attempt >= 1),
  CONSTRAINT chk_workflow_step_attempt_status
    CHECK (
      status IN (
        'pending',
        'running',
        'waiting',
        'completed',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT chk_workflow_step_attempt_policy
    CHECK (jsonb_typeof(policy) = 'object'),
  CONSTRAINT chk_workflow_step_attempt_completion
    CHECK (
      (status IN ('completed', 'failed', 'canceled') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed', 'canceled') AND completed_at IS NULL)
    )
);

CREATE INDEX idx_workflow_step_attempts_run
  ON workflow_step_attempts(run_id, step_index, attempt);

-- workflow_runs and workflow_run_states both point back to step attempts, so
-- these cycle-closing constraints are added only after both tables exist.
ALTER TABLE workflow_runs
  ADD CONSTRAINT fk_workflow_runs_parent_run
    FOREIGN KEY (parent_run_id, project_id)
    REFERENCES workflow_runs(id, project_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_workflow_runs_parent_step_attempt
    FOREIGN KEY (parent_run_id, parent_workflow_step_attempt_id)
    REFERENCES workflow_step_attempts(run_id, id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE workflow_run_states
  ADD CONSTRAINT fk_workflow_run_states_active_step_attempt
    FOREIGN KEY (run_id, active_workflow_step_attempt_id)
    REFERENCES workflow_step_attempts(run_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE workflow_pauses (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'open',
  state_present               boolean NOT NULL DEFAULT false,
  state                       jsonb,
  timeout_at                  timestamptz,
  resume_value                jsonb,
  resume_idempotency_key      varchar(255),
  resume_payload_hash         char(64),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  resolved_at                 timestamptz,
  CONSTRAINT uq_workflow_pause_step_attempt
    UNIQUE (run_id, workflow_step_attempt_id),
  CONSTRAINT fk_workflow_pause_step_attempt
    FOREIGN KEY (run_id, workflow_step_attempt_id)
    REFERENCES workflow_step_attempts(run_id, id)
    ON DELETE CASCADE,
  CONSTRAINT chk_workflow_pause_status
    CHECK (status IN ('open', 'resumed', 'timed_out', 'canceled')),
  CONSTRAINT chk_workflow_pause_state
    CHECK (state_present OR state IS NULL),
  CONSTRAINT chk_workflow_pause_resolution
    CHECK (
      (status = 'open' AND resolved_at IS NULL)
      OR
      (status <> 'open' AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX idx_workflow_pauses_due
  ON workflow_pauses(timeout_at, id)
  WHERE status = 'open' AND timeout_at IS NOT NULL;

CREATE INDEX idx_workflow_pauses_run
  ON workflow_pauses(run_id, status);

CREATE TABLE batch_execution_states (
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  source_snapshot             jsonb,
  source_cursor               jsonb,
  source_consistency          varchar(20),
  estimated_count             bigint,
  discovered_count            bigint NOT NULL DEFAULT 0,
  completed_count             bigint NOT NULL DEFAULT 0,
  failed_count                bigint NOT NULL DEFAULT 0,
  skipped_count               bigint NOT NULL DEFAULT 0,
  failure_policy              jsonb,
  source_done                 boolean NOT NULL DEFAULT false,
  source_page_queued          boolean NOT NULL DEFAULT false,
  sink_state                  jsonb,
  sink_artifact               jsonb,
  sink_completed_chunks       bigint NOT NULL DEFAULT 0,
  sink_total_chunks           bigint NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, workflow_step_attempt_id),
  CONSTRAINT fk_batch_execution_step_attempt
    FOREIGN KEY (run_id, workflow_step_attempt_id)
    REFERENCES workflow_step_attempts(run_id, id)
    ON DELETE CASCADE,
  CONSTRAINT chk_batch_source_consistency
    CHECK (
      source_consistency IS NULL
      OR source_consistency IN ('snapshot', 'bounded', 'best_effort')
    ),
  CONSTRAINT chk_batch_estimated_count
    CHECK (estimated_count IS NULL OR estimated_count >= 0),
  CONSTRAINT chk_batch_discovered_count CHECK (discovered_count >= 0),
  CONSTRAINT chk_batch_completed_count CHECK (completed_count >= 0),
  CONSTRAINT chk_batch_failed_count CHECK (failed_count >= 0),
  CONSTRAINT chk_batch_skipped_count CHECK (skipped_count >= 0),
  CONSTRAINT chk_batch_sink_completed_chunks CHECK (sink_completed_chunks >= 0),
  CONSTRAINT chk_batch_sink_total_chunks CHECK (sink_total_chunks >= 0),
  CONSTRAINT chk_batch_sink_chunk_progress
    CHECK (sink_completed_chunks <= sink_total_chunks)
);

CREATE TABLE batch_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  item_key                    varchar(500) NOT NULL,
  source_order                bigint NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'pending',
  value                       jsonb,
  value_reference             jsonb,
  output                      jsonb,
  output_reference            jsonb,
  error                       text,
  current_node_id             varchar(255),
  available_at                timestamptz NOT NULL DEFAULT now(),
  attempt                     integer NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  CONSTRAINT uq_batch_item_key
    UNIQUE (run_id, workflow_step_attempt_id, item_key),
  CONSTRAINT uq_batch_item_order
    UNIQUE (run_id, workflow_step_attempt_id, source_order),
  CONSTRAINT uq_batch_item_scope
    UNIQUE (run_id, workflow_step_attempt_id, id),
  CONSTRAINT fk_batch_item_execution
    FOREIGN KEY (run_id, workflow_step_attempt_id)
    REFERENCES batch_execution_states(run_id, workflow_step_attempt_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_batch_item_status
    CHECK (
      status IN (
        'pending',
        'running',
        'waiting',
        'succeeded',
        'failed',
        'skipped',
        'canceled'
      )
    ),
  CONSTRAINT chk_batch_item_source_order CHECK (source_order >= 0),
  CONSTRAINT chk_batch_item_attempt CHECK (attempt >= 0),
  CONSTRAINT chk_batch_item_value
    CHECK ((value IS NULL) <> (value_reference IS NULL)),
  CONSTRAINT chk_batch_item_output
    CHECK (output IS NULL OR output_reference IS NULL),
  CONSTRAINT chk_batch_item_completion
    CHECK (
      (
        status IN ('succeeded', 'failed', 'skipped', 'canceled')
        AND completed_at IS NOT NULL
      )
      OR
      (
        status NOT IN ('succeeded', 'failed', 'skipped', 'canceled')
        AND completed_at IS NULL
      )
    )
);

CREATE INDEX idx_batch_items_ready
  ON batch_items(
    run_id,
    workflow_step_attempt_id,
    status,
    available_at,
    source_order
  )
  WHERE status IN ('pending', 'waiting');

CREATE INDEX idx_batch_items_status
  ON batch_items(run_id, workflow_step_attempt_id, status);

CREATE TABLE batch_step_invocations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  node_id                     varchar(255) NOT NULL,
  function_name               varchar(255) NOT NULL,
  compatibility_key           char(64) NOT NULL,
  policy                      jsonb NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'pending',
  attempt                     integer NOT NULL DEFAULT 0,
  closes_at                   timestamptz NOT NULL,
  started_at                  timestamptz,
  completed_at                timestamptz,
  error                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_batch_step_invocation_scope
    UNIQUE (run_id, workflow_step_attempt_id, id),
  CONSTRAINT fk_batch_step_invocation_execution
    FOREIGN KEY (run_id, workflow_step_attempt_id)
    REFERENCES batch_execution_states(run_id, workflow_step_attempt_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_batch_step_invocation_policy
    CHECK (jsonb_typeof(policy) = 'object'),
  CONSTRAINT chk_batch_step_invocation_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
  CONSTRAINT chk_batch_step_invocation_attempt CHECK (attempt >= 0),
  CONSTRAINT chk_batch_step_invocation_completion
    CHECK (
      (status IN ('completed', 'failed', 'canceled') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed', 'canceled') AND completed_at IS NULL)
    )
);

CREATE INDEX idx_batch_step_invocations_ready
  ON batch_step_invocations(status, closes_at, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_batch_step_invocations_scope
  ON batch_step_invocations(run_id, workflow_step_attempt_id, status);

CREATE TABLE batch_step_members (
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  invocation_id               uuid NOT NULL,
  item_id                     uuid NOT NULL,
  member_key                  varchar(500) NOT NULL,
  input                       jsonb,
  status                      varchar(20) NOT NULL DEFAULT 'pending',
  output                      jsonb,
  error                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  PRIMARY KEY (
    run_id,
    workflow_step_attempt_id,
    invocation_id,
    item_id
  ),
  CONSTRAINT uq_batch_step_member_key
    UNIQUE (
      run_id,
      workflow_step_attempt_id,
      invocation_id,
      member_key
    ),
  CONSTRAINT fk_batch_step_member_invocation
    FOREIGN KEY (run_id, workflow_step_attempt_id, invocation_id)
    REFERENCES batch_step_invocations(run_id, workflow_step_attempt_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_batch_step_member_item
    FOREIGN KEY (run_id, workflow_step_attempt_id, item_id)
    REFERENCES batch_items(run_id, workflow_step_attempt_id, id)
    ON DELETE CASCADE,
  CONSTRAINT chk_batch_step_member_status
    CHECK (status IN ('pending', 'succeeded', 'failed', 'unresolved')),
  CONSTRAINT chk_batch_step_member_completion
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR
      (status <> 'pending' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_batch_step_members_item
  ON batch_step_members(run_id, workflow_step_attempt_id, item_id);

CREATE TABLE batch_item_steps (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  item_id                     uuid NOT NULL,
  node_id                     varchar(255) NOT NULL,
  occurrence                  integer NOT NULL DEFAULT 0,
  name                        varchar(255) NOT NULL,
  status                      varchar(20) NOT NULL,
  input                       jsonb,
  output                      jsonb,
  error                       text,
  attempt                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  started_at                  timestamptz,
  completed_at                timestamptz,
  CONSTRAINT uq_batch_item_step_attempt
    UNIQUE (
      run_id,
      workflow_step_attempt_id,
      item_id,
      node_id,
      occurrence,
      attempt
    ),
  CONSTRAINT fk_batch_item_step_item
    FOREIGN KEY (run_id, workflow_step_attempt_id, item_id)
    REFERENCES batch_items(run_id, workflow_step_attempt_id, id)
    ON DELETE CASCADE,
  CONSTRAINT chk_batch_item_step_occurrence CHECK (occurrence >= 0),
  CONSTRAINT chk_batch_item_step_attempt CHECK (attempt >= 1),
  CONSTRAINT chk_batch_item_step_status
    CHECK (
      status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'waiting')
    ),
  CONSTRAINT chk_batch_item_step_completion
    CHECK (
      (status IN ('completed', 'failed', 'skipped') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed', 'skipped') AND completed_at IS NULL)
    )
);

CREATE INDEX idx_batch_item_steps_item
  ON batch_item_steps(run_id, workflow_step_attempt_id, item_id, created_at);

CREATE TABLE batch_sink_chunks (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                      uuid NOT NULL,
  workflow_step_attempt_id    uuid NOT NULL,
  chunk_key                   varchar(500) NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'pending',
  first_order                 bigint NOT NULL,
  last_order                  bigint NOT NULL,
  item_count                  integer NOT NULL,
  attempt                     integer NOT NULL DEFAULT 0,
  acknowledgement             jsonb,
  artifact                    jsonb,
  error                       text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  CONSTRAINT uq_batch_sink_chunk
    UNIQUE (run_id, workflow_step_attempt_id, chunk_key),
  CONSTRAINT fk_batch_sink_chunk_execution
    FOREIGN KEY (run_id, workflow_step_attempt_id)
    REFERENCES batch_execution_states(run_id, workflow_step_attempt_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_batch_sink_chunk_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT chk_batch_sink_chunk_order
    CHECK (first_order >= 0 AND last_order >= first_order),
  CONSTRAINT chk_batch_sink_chunk_item_count CHECK (item_count > 0),
  CONSTRAINT chk_batch_sink_chunk_attempt CHECK (attempt >= 0),
  CONSTRAINT chk_batch_sink_chunk_completion
    CHECK (
      (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed') AND completed_at IS NULL)
    )
);

CREATE INDEX idx_batch_sink_chunks_ready
  ON batch_sink_chunks(
    run_id,
    workflow_step_attempt_id,
    status,
    first_order
  );

CREATE TABLE execution_jobs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id             uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_step_attempt_id    uuid,
  kind                        varchar(50) NOT NULL,
  payload                     jsonb NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'pending',
  priority                    integer NOT NULL DEFAULT 0,
  available_at                timestamptz NOT NULL DEFAULT now(),
  attempt                     integer NOT NULL DEFAULT 0,
  max_attempts                integer NOT NULL DEFAULT 5,
  leased_by                   varchar(255),
  lease_token                 uuid,
  lease_generation            bigint NOT NULL DEFAULT 0,
  heartbeat_at                timestamptz,
  lease_expires_at            timestamptz,
  dedupe_key                  varchar(500),
  last_error                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  CONSTRAINT fk_execution_job_step_attempt
    FOREIGN KEY (workflow_run_id, workflow_step_attempt_id)
    REFERENCES workflow_step_attempts(run_id, id)
    ON DELETE CASCADE,
  CONSTRAINT chk_execution_job_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),
  CONSTRAINT chk_execution_job_attempt CHECK (attempt >= 0),
  CONSTRAINT chk_execution_job_max_attempts CHECK (max_attempts >= 1),
  CONSTRAINT chk_execution_job_lease_generation CHECK (lease_generation >= 0),
  CONSTRAINT chk_execution_job_lease
    CHECK (
      (
        status = 'running'
        AND leased_by IS NOT NULL
        AND lease_token IS NOT NULL
        AND heartbeat_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR
      (
        status <> 'running'
        AND leased_by IS NULL
        AND lease_token IS NULL
        AND heartbeat_at IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT chk_execution_job_completion
    CHECK (
      (status IN ('completed', 'failed', 'canceled') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed', 'canceled') AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX uq_execution_job_dedupe
  ON execution_jobs(tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_execution_jobs_claim
  ON execution_jobs(status, available_at, priority DESC, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_execution_jobs_lease
  ON execution_jobs(lease_expires_at)
  WHERE status = 'running';

CREATE INDEX idx_execution_jobs_workflow_run
  ON execution_jobs(workflow_run_id, status);

CREATE INDEX idx_execution_jobs_step_attempt
  ON execution_jobs(workflow_run_id, workflow_step_attempt_id, status)
  WHERE workflow_step_attempt_id IS NOT NULL;

-- Plain function invocations retain event replay and graph-linked step history.
CREATE TABLE workflow_run_events (
  id              bigserial PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  invocation_id   varchar(255) NOT NULL,
  sequence        integer NOT NULL,
  attempt         integer NOT NULL DEFAULT 1,
  type            varchar(50) NOT NULL,
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workflow_run_event_sequence
    UNIQUE (invocation_id, sequence),
  CONSTRAINT chk_workflow_run_event_sequence CHECK (sequence >= 0),
  CONSTRAINT chk_workflow_run_event_attempt CHECK (attempt >= 1)
);

CREATE INDEX idx_workflow_run_events_run_sequence
  ON workflow_run_events(run_id, created_at, sequence);

CREATE TABLE workflow_run_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         varchar(255) NOT NULL,
  occurrence      integer NOT NULL DEFAULT 0,
  name            varchar(255) NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'pending',
  input           jsonb,
  output          jsonb,
  error           text,
  attempt         integer NOT NULL DEFAULT 1,
  started_at      timestamptz,
  completed_at    timestamptz,
  CONSTRAINT uq_workflow_run_step_occurrence
    UNIQUE (run_id, node_id, occurrence),
  CONSTRAINT chk_workflow_run_step_occurrence CHECK (occurrence >= 0),
  CONSTRAINT chk_workflow_run_step_attempt CHECK (attempt >= 1),
  CONSTRAINT chk_workflow_run_step_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  CONSTRAINT chk_workflow_run_step_completion
    CHECK (
      (status IN ('completed', 'failed', 'skipped') AND completed_at IS NOT NULL)
      OR
      (status NOT IN ('completed', 'failed', 'skipped') AND completed_at IS NULL)
    )
);

CREATE INDEX idx_workflow_run_steps_run
  ON workflow_run_steps(run_id, started_at, id);
