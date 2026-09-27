-- Keyed chats belong to the project, not the workflow (ADR 0173). A chat key
-- was stored as JSON.stringify([workflowName, key]); it is now the plain key,
-- so every automation in a project reaches the same chat for `pr-42`. The
-- workflows that delivered to a chat are recorded beside it.
DROP INDEX uq_agent_sessions_active_chat_key;

ALTER TABLE agent_sessions
  ADD COLUMN chat_workflows jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the chat runs and why (ADR 0173): its Environment, the rule that
  -- chose it, and the machine holding its workspace.
  ADD COLUMN placement jsonb;

UPDATE agent_sessions
SET chat_workflows = jsonb_build_array(chat_key::jsonb ->> 0),
    chat_key = chat_key::jsonb ->> 1
WHERE CASE
  WHEN chat_key LIKE '["%",%]' THEN jsonb_typeof(chat_key::jsonb) = 'array'
  ELSE false
END;

-- Two workflows may have kept a chat for the same key; the newest keeps it.
UPDATE agent_sessions AS session
SET chat_key = NULL
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY project_id, external_user_id, chat_key
    ORDER BY created_at DESC
  ) AS rank
  FROM agent_sessions
  WHERE chat_key IS NOT NULL AND status = 'active'
) AS ranked
WHERE session.id = ranked.id AND ranked.rank > 1;

-- One open chat per project owner and key. Closing a chat frees its key.
CREATE UNIQUE INDEX uq_agent_sessions_active_chat_key
  ON agent_sessions(project_id, external_user_id, chat_key)
  WHERE chat_key IS NOT NULL AND status = 'active';

-- Why an Allocation ended. `idle` Allocations belong to chats that gave back
-- their workspace while waiting; their next turn admits a fresh one.
ALTER TABLE execution_allocations ADD COLUMN release_reason text;
