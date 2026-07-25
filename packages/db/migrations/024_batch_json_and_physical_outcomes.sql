ALTER TABLE batch_execution_states
  ADD COLUMN source_snapshot_present boolean NOT NULL DEFAULT false,
  ADD COLUMN source_cursor_present boolean NOT NULL DEFAULT false,
  ADD COLUMN sink_state_present boolean NOT NULL DEFAULT false;

UPDATE batch_execution_states
SET
  source_snapshot_present = source_snapshot IS NOT NULL,
  source_cursor_present = source_cursor IS NOT NULL,
  sink_state_present = sink_state IS NOT NULL;

ALTER TABLE batch_execution_states
  ADD CONSTRAINT chk_batch_source_snapshot_presence
    CHECK (source_snapshot_present = (source_snapshot IS NOT NULL)),
  ADD CONSTRAINT chk_batch_source_cursor_presence
    CHECK (source_cursor_present = (source_cursor IS NOT NULL)),
  ADD CONSTRAINT chk_batch_sink_state_presence
    CHECK (sink_state_present = (sink_state IS NOT NULL));

ALTER TABLE batch_items
  ADD COLUMN value_storage varchar(20),
  ADD COLUMN output_storage varchar(20);

UPDATE batch_items
SET
  value_storage = CASE
    WHEN value_reference IS NOT NULL THEN 'reference'
    ELSE 'inline'
  END,
  output_storage = CASE
    WHEN output_reference IS NOT NULL THEN 'reference'
    WHEN output IS NOT NULL THEN 'inline'
    ELSE NULL
  END;

ALTER TABLE batch_items
  ALTER COLUMN value_storage SET NOT NULL,
  DROP CONSTRAINT chk_batch_item_value,
  DROP CONSTRAINT chk_batch_item_output,
  ADD CONSTRAINT chk_batch_item_value_storage
    CHECK (
      (
        value_storage = 'inline'
        AND value IS NOT NULL
        AND value_reference IS NULL
      )
      OR
      (
        value_storage = 'reference'
        AND value IS NULL
        AND value_reference IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_batch_item_output_storage
    CHECK (
      (output_storage IS NULL AND output IS NULL AND output_reference IS NULL)
      OR
      (
        output_storage = 'inline'
        AND output IS NOT NULL
        AND output_reference IS NULL
      )
      OR
      (
        output_storage = 'reference'
        AND output IS NULL
        AND output_reference IS NOT NULL
      )
    );

ALTER TABLE batch_step_members
  ADD COLUMN occurrence integer NOT NULL DEFAULT 0,
  ADD COLUMN input_present boolean NOT NULL DEFAULT true,
  ADD COLUMN output_present boolean NOT NULL DEFAULT false;

UPDATE batch_step_members
SET output_present = output IS NOT NULL;

ALTER TABLE batch_step_members
  DROP CONSTRAINT chk_batch_step_member_status,
  ADD CONSTRAINT chk_batch_step_member_status
    CHECK (status IN ('pending', 'succeeded', 'failed', 'skipped', 'unresolved')),
  ADD CONSTRAINT chk_batch_step_member_occurrence CHECK (occurrence >= 0),
  ADD CONSTRAINT chk_batch_step_member_input_presence
    CHECK (input_present = (input IS NOT NULL)),
  ADD CONSTRAINT chk_batch_step_member_output_presence
    CHECK (output_present = (output IS NOT NULL));

ALTER TABLE batch_item_steps
  ADD COLUMN input_present boolean NOT NULL DEFAULT false,
  ADD COLUMN output_present boolean NOT NULL DEFAULT false;

UPDATE batch_item_steps
SET
  input_present = input IS NOT NULL,
  output_present = output IS NOT NULL;

ALTER TABLE batch_item_steps
  ADD CONSTRAINT chk_batch_item_step_input_presence
    CHECK (input_present = (input IS NOT NULL)),
  ADD CONSTRAINT chk_batch_item_step_output_presence
    CHECK (output_present = (output IS NOT NULL));
