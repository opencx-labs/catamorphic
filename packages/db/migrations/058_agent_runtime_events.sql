-- Provider-normalized events are durable before any host subscriber observes
-- them. Per-session sequences are append-only and both provider event ids and
-- sequences are idempotency keys.
CREATE TABLE agent_runtime_events (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id text NOT NULL,
  turn_id text,
  provider_payload_ref text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sequence),
  CONSTRAINT uq_agent_runtime_event_id UNIQUE (session_id, event_id)
);

-- The primary key supports exclusive `after sequence` cursor scans.

-- Requests may be resolved independently of the provider connection. The
-- revision makes a response or expiry transition a single-winner update.
CREATE TABLE agent_runtime_requests (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  turn_id text,
  kind text NOT NULL CHECK (kind IN ('approval', 'question', 'elicitation')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'expired', 'cancelled')),
  expires_at timestamptz,
  response jsonb,
  resolved_by_external_user_id varchar(255),
  resolved_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, request_id)
);

CREATE INDEX idx_agent_runtime_requests_pending_expiry
  ON agent_runtime_requests(session_id, expires_at)
  WHERE status = 'pending';
