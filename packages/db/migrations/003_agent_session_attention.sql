-- A workflow can wake one stable member-owned agent session and ask the
-- user's clients to surface it when the turn settles (ADR 0087).

ALTER TABLE agent_sessions
  ADD COLUMN wake_key varchar(500),
  ADD COLUMN attention_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN attention_seen_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE agent_sessions
  ADD CONSTRAINT chk_agent_session_attention_revision
    CHECK (attention_revision >= 0),
  ADD CONSTRAINT chk_agent_session_attention_seen_revision
    CHECK (
      attention_seen_revision >= 0
      AND attention_seen_revision <= attention_revision
    );

CREATE UNIQUE INDEX uq_agent_sessions_active_wake_key
  ON agent_sessions(project_id, external_user_id, wake_key)
  WHERE wake_key IS NOT NULL AND status = 'active';
