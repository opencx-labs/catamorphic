-- Messages written in one transaction share created_at (now() is frozen per
-- transaction), so ordering by timestamp alone interleaves user/assistant
-- pairs nondeterministically. A sequence gives a total insertion order.
ALTER TABLE agent_messages ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX idx_agent_messages_session_seq ON agent_messages(session_id, seq);
