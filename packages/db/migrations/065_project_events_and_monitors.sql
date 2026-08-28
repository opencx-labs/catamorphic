-- Durable project event log and placement-aware event-source monitors
-- (ADR 0074). Sources observe; watcher workflows decide and act.

CREATE TABLE project_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source        varchar(100) NOT NULL,
  kind          varchar(200) NOT NULL,
  external_id   varchar(500) NOT NULL,
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL,
  UNIQUE(project_id, source, external_id)
);
CREATE INDEX idx_project_events_replay
  ON project_events(project_id, sequence);
CREATE INDEX idx_project_events_kind
  ON project_events(project_id, kind, sequence);

CREATE TABLE project_event_monitors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind            varchar(100) NOT NULL,
  source_key             varchar(500) NOT NULL,
  owner_external_user_id varchar(255) NOT NULL,
  placement              varchar(20) NOT NULL,
  config                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor                 jsonb,
  status                 varchar(20) NOT NULL DEFAULT 'active',
  poll_interval_seconds  integer NOT NULL DEFAULT 30,
  next_poll_at           timestamptz NOT NULL DEFAULT now(),
  lease_owner            varchar(255),
  lease_token            uuid,
  lease_expires_at       timestamptz,
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, source_kind, source_key, owner_external_user_id),
  CONSTRAINT chk_project_event_monitor_placement CHECK (
    placement IN ('local', 'remote', 'any')
  ),
  CONSTRAINT chk_project_event_monitor_status CHECK (
    status IN ('active', 'paused', 'stopped')
  ),
  CONSTRAINT chk_project_event_monitor_poll_interval CHECK (
    poll_interval_seconds BETWEEN 5 AND 86400
  )
);
CREATE INDEX idx_project_event_monitors_claim
  ON project_event_monitors(status, placement, next_poll_at, lease_expires_at);
