ALTER TABLE batch_item_steps
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

ALTER TABLE batch_item_steps
  DROP CONSTRAINT IF EXISTS uq_batch_item_step_occurrence;

CREATE UNIQUE INDEX uq_batch_item_step_attempt
  ON batch_item_steps (item_id, node_id, occurrence, attempt);
