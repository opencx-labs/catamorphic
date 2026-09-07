ALTER TABLE watchers ADD COLUMN ref_deleted_at timestamptz;
CREATE INDEX watchers_pending_retirement ON watchers(updated_at)
  WHERE status IN ('stopped', 'expired') AND ref_deleted_at IS NULL;
