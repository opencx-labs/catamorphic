-- Model authority ends with the exact attempt and lease that issued it.
-- Other capabilities on the same alias keep their existing lifetime.
ALTER TABLE connection_capability_grants
  ADD COLUMN model_turn_id uuid,
  ADD COLUMN model_attempt_id uuid,
  ADD COLUMN model_lease_token uuid,
  ADD CONSTRAINT connection_grant_model_fence CHECK (
    (model_turn_id IS NULL AND model_attempt_id IS NULL AND model_lease_token IS NULL)
    OR (model_turn_id IS NOT NULL AND model_attempt_id IS NOT NULL
      AND model_lease_token IS NOT NULL AND agent_session_id IS NOT NULL)
  );
