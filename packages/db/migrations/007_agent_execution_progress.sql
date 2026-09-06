-- Execution belongs to the durable turn, never to message placeholders or
-- the HTTP request which submitted it. Provider activity is not a heartbeat.
ALTER TABLE agent_turns
  ADD COLUMN phase text NOT NULL DEFAULT 'preparing'
    CHECK (phase IN ('preparing', 'working', 'waiting', 'saving')),
  ADD COLUMN activity text,
  ADD COLUMN activity_at timestamptz,
  ADD COLUMN cancellation_requested_at timestamptz;
