-- Explicit cross-host session handoff, durable replication and push delivery,
-- and materialized schedule trigger occurrences (ADR 0077).

ALTER TABLE agent_sessions
  ADD COLUMN authority_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN mirror_message_count integer NOT NULL DEFAULT 0,
  ADD COLUMN handoff_status varchar(20) NOT NULL DEFAULT 'none',
  ADD COLUMN handoff_destination_host_id varchar(255),
  ADD CONSTRAINT chk_agent_session_handoff_status CHECK (
    handoff_status IN ('none', 'pending')
  );

CREATE INDEX idx_agent_sessions_resumable
  ON agent_sessions(authority_host_id, authority_seen_at)
  WHERE status = 'active' AND mirror_message_count > 0;

CREATE TABLE session_sync_intents (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id                   uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  destination_key              varchar(500) NOT NULL,
  desired_authority_revision   bigint NOT NULL,
  desired_message_count        integer NOT NULL,
  acknowledged_authority_revision bigint,
  acknowledged_message_count  integer,
  status                       varchar(20) NOT NULL DEFAULT 'pending',
  attempt_count                integer NOT NULL DEFAULT 0,
  next_attempt_at              timestamptz NOT NULL DEFAULT now(),
  lease_owner                  varchar(255),
  lease_expires_at             timestamptz,
  last_error                   text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_session_sync_destination UNIQUE(session_id, destination_key),
  CONSTRAINT chk_session_sync_status CHECK (
    status IN ('pending', 'leased', 'acknowledged', 'diverged')
  )
);

CREATE INDEX idx_session_sync_claim
  ON session_sync_intents(status, next_attempt_at, lease_expires_at);

CREATE TABLE user_notification_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_user_id   varchar(255) NOT NULL,
  project_id         uuid REFERENCES projects(id) ON DELETE CASCADE,
  session_id         uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind               varchar(100) NOT NULL,
  title              varchar(255) NOT NULL,
  body               text NOT NULL,
  route              text NOT NULL,
  collapse_key       varchar(500) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_notification_collapse
    UNIQUE(tenant_id, external_user_id, collapse_key)
);

CREATE INDEX idx_user_notification_session
  ON user_notification_events(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

CREATE TABLE push_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_user_id   varchar(255) NOT NULL,
  endpoint_hash      char(64) NOT NULL,
  endpoint           text NOT NULL,
  p256dh             text NOT NULL,
  auth_secret        text NOT NULL,
  user_agent         text,
  expires_at         timestamptz,
  retired_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_push_subscription_endpoint
    UNIQUE(tenant_id, external_user_id, endpoint_hash)
);

CREATE INDEX idx_push_subscriptions_user
  ON push_subscriptions(tenant_id, external_user_id)
  WHERE retired_at IS NULL;

CREATE TABLE notification_deliveries (
  event_id            uuid NOT NULL REFERENCES user_notification_events(id) ON DELETE CASCADE,
  subscription_id     uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  attempt_count       integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  lease_owner         varchar(255),
  lease_expires_at    timestamptz,
  last_error          text,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id, subscription_id),
  CONSTRAINT chk_notification_delivery_status CHECK (
    status IN ('pending', 'leased', 'delivered', 'retired')
  )
);

CREATE INDEX idx_notification_delivery_claim
  ON notification_deliveries(status, next_attempt_at, lease_expires_at);

CREATE TABLE schedule_bindings (
  binding_id          uuid PRIMARY KEY REFERENCES trigger_bindings(id) ON DELETE CASCADE,
  cron_expression     varchar(255) NOT NULL,
  timezone            varchar(100) NOT NULL,
  next_fire_at        timestamptz NOT NULL,
  last_scheduled_for  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_bindings_due
  ON schedule_bindings(next_fire_at);

CREATE TABLE schedule_occurrences (
  binding_id          uuid NOT NULL REFERENCES schedule_bindings(binding_id) ON DELETE CASCADE,
  scheduled_for       timestamptz NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'pending',
  run_ids             jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempt_count       integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  lease_owner         varchar(255),
  lease_expires_at    timestamptz,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  PRIMARY KEY(binding_id, scheduled_for),
  CONSTRAINT chk_schedule_occurrence_status CHECK (
    status IN ('pending', 'leased', 'enrolled', 'skipped', 'failed')
  )
);

CREATE INDEX idx_schedule_occurrence_claim
  ON schedule_occurrences(status, next_attempt_at, lease_expires_at);
