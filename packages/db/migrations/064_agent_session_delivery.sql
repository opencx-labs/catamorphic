-- Durable, attributed session delivery (ADR 0074). Messages are the inbox;
-- turns are the serialized execution requests derived from inbox messages.

ALTER TABLE agent_messages
  ADD COLUMN author_kind varchar(20) NOT NULL DEFAULT 'user',
  ADD COLUMN author_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN delivery_mode varchar(20) NOT NULL DEFAULT 'next_turn',
  ADD COLUMN idempotency_key varchar(500);

ALTER TABLE agent_messages
  ADD CONSTRAINT chk_agent_message_author_kind CHECK (
    author_kind IN ('user', 'agent', 'workflow', 'watcher', 'system')
  ),
  ADD CONSTRAINT chk_agent_message_delivery_mode CHECK (
    delivery_mode IN ('message_only', 'next_turn', 'interrupt')
  );

CREATE UNIQUE INDEX uq_agent_message_delivery_idempotency
  ON agent_messages(session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE agent_turns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  message_id        uuid NOT NULL UNIQUE REFERENCES agent_messages(id) ON DELETE CASCADE,
  result_message_id uuid REFERENCES agent_messages(id) ON DELETE SET NULL,
  delivery_mode     varchar(20) NOT NULL,
  status            varchar(20) NOT NULL DEFAULT 'queued',
  priority          integer NOT NULL DEFAULT 0,
  attempt           integer NOT NULL DEFAULT 0,
  available_at      timestamptz NOT NULL DEFAULT now(),
  lease_owner       varchar(255),
  lease_token       uuid,
  lease_expires_at  timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_turn_delivery_mode CHECK (
    delivery_mode IN ('next_turn', 'interrupt')
  ),
  CONSTRAINT chk_agent_turn_status CHECK (
    status IN ('queued', 'held', 'running', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX idx_agent_turns_claim
  ON agent_turns(status, available_at, priority DESC, created_at);
CREATE INDEX idx_agent_turns_session
  ON agent_turns(session_id, created_at);
CREATE UNIQUE INDEX uq_agent_turns_running_session
  ON agent_turns(session_id)
  WHERE status = 'running';
