-- Temporary code-first watcher deployments and event/run provenance
-- (ADR 0074). Source is pinned on a dedicated git ref, never merged to main.

CREATE TABLE watchers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id             uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  monitor_id             uuid REFERENCES project_event_monitors(id) ON DELETE SET NULL,
  owner_external_user_id varchar(255) NOT NULL,
  owner_identity         jsonb NOT NULL,
  workflow_name          varchar(255) NOT NULL,
  source_path            varchar(1000) NOT NULL,
  remote_branch          varchar(500) NOT NULL,
  commit_sha             char(40) NOT NULL,
  deployment_artifact_id uuid NOT NULL REFERENCES deployment_artifacts(id),
  environment_name       varchar(255),
  event_kinds            jsonb NOT NULL,
  cursor_sequence        bigint NOT NULL DEFAULT 0,
  status                 varchar(20) NOT NULL DEFAULT 'active',
  expires_at             timestamptz,
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_watcher_status CHECK (
    status IN ('active', 'paused', 'stopped', 'expired')
  )
);
CREATE INDEX idx_watchers_dispatch
  ON watchers(status, project_id, cursor_sequence);
CREATE INDEX idx_watchers_session
  ON watchers(session_id, created_at);

CREATE TABLE watcher_runs (
  watcher_id uuid NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES project_events(id) ON DELETE CASCADE,
  run_id     uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(watcher_id, event_id),
  UNIQUE(run_id)
);
