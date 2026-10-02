-- Rows that reference session log rows, indexed so deleting an item, a
-- thread, an attempt or a session (a project delete, a mirror replaced by
-- its base) finds them without scanning every session's turns.
CREATE INDEX agent_turns_input_item ON agent_turns (input_item_id)
    WHERE input_item_id IS NOT NULL;
CREATE INDEX agent_turns_provider_thread ON agent_turns (provider_thread_id)
    WHERE provider_thread_id IS NOT NULL;
CREATE INDEX agent_turn_attempts_provider_thread ON agent_turn_attempts (provider_thread_id)
    WHERE provider_thread_id IS NOT NULL;
CREATE INDEX agent_turn_attempts_session ON agent_turn_attempts (session_id);
CREATE INDEX agent_turn_commands_attempt ON agent_turn_commands (attempt_id)
    WHERE attempt_id IS NOT NULL;
CREATE INDEX agent_delegations_result_item ON agent_delegations (result_item_id)
    WHERE result_item_id IS NOT NULL;
