-- A provider thread's native state is the harness's own data (ADR 0198),
-- kept exactly as the harness wrote it. jsonb sorts object keys, so a
-- Claude Code thread resumed from Work sent its model a history that was
-- no longer the one it had cached (tool inputs among the reordered
-- objects), and the turn paid for its whole conversation again. json keeps
-- the text as written. Rows already stored keep the order jsonb gave them.
ALTER TABLE agent_provider_thread_entries
    ALTER COLUMN entry TYPE json USING entry::json;
