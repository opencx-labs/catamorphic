UPDATE agent_sessions
SET status = 'closed', updated_at = now()
WHERE provider = 'flue' AND status = 'active';
