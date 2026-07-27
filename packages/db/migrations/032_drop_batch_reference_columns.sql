-- Drop the never-implemented reference storage for batch item payloads.
--
-- value_reference/output_reference and the value_storage/output_storage
-- discriminators were reserved for out-of-band payload storage, but no writer
-- ever produced a reference and the item executor hard-failed on one
-- ("Referenced batch values require a host resolver"). Every batch_items
-- insert paid the two-way CHECK constraints for a branch that could not
-- occur. Inline is now the only representation: value is NOT NULL, output is
-- set exactly when the item succeeded with a result.
ALTER TABLE batch_items
  DROP CONSTRAINT chk_batch_item_value_storage,
  DROP CONSTRAINT chk_batch_item_output_storage,
  DROP COLUMN value_reference,
  DROP COLUMN output_reference,
  DROP COLUMN value_storage,
  DROP COLUMN output_storage;

ALTER TABLE batch_items
  ALTER COLUMN value SET NOT NULL;
