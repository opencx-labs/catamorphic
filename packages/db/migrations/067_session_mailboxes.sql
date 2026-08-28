-- Cross-host session authority and durable delivery mailboxes (ADR 0074).

ALTER TABLE agent_sessions
  ADD COLUMN authority_host_id varchar(255) NOT NULL DEFAULT 'unassigned',
  ADD COLUMN authority_revision bigint NOT NULL DEFAULT 1;

CREATE TABLE session_mailbox_items (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                 uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id                 uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  source_host_id             varchar(255) NOT NULL,
  destination_host_id        varchar(255) NOT NULL,
  authority_revision         bigint NOT NULL,
  message_id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  content                    text NOT NULL,
  author_kind                varchar(20) NOT NULL,
  author_payload             jsonb NOT NULL,
  delivery_mode              varchar(20) NOT NULL,
  idempotency_key            varchar(500),
  metadata                   jsonb,
  status                     varchar(20) NOT NULL DEFAULT 'pending',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  acknowledged_at            timestamptz,
  CONSTRAINT chk_session_mailbox_author_kind CHECK (
    author_kind IN ('user', 'agent', 'workflow', 'watcher', 'system')
  ),
  CONSTRAINT chk_session_mailbox_delivery_mode CHECK (
    delivery_mode IN ('message_only', 'next_turn', 'interrupt')
  ),
  CONSTRAINT chk_session_mailbox_status CHECK (
    status IN ('pending', 'acknowledged')
  )
);

CREATE UNIQUE INDEX uq_session_mailbox_message
  ON session_mailbox_items(session_id, message_id);
CREATE UNIQUE INDEX uq_session_mailbox_idempotency
  ON session_mailbox_items(session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_session_mailbox_destination
  ON session_mailbox_items(destination_host_id, status, created_at);
