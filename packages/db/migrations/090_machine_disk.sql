-- Disk is a resource Work manages on machines (ADR 0335).
--
-- disk: the machine's latest report of the filesystem it writes to with
-- the least room above its floor: { path, totalBytes, freeBytes,
-- floorBytes, measuredAt }. Null for a machine that reports none.
-- disk_low_at: when its current episode under the floor began; null when
-- it is not in one. Set and cleared by one conditional update each, so an
-- episode is recorded once whichever replica hears the report.
-- disk_low_recorded_at: the episode whose event was recorded, so a failed
-- recording is tried again on the episode's next report.
ALTER TABLE worker_nodes
  ADD COLUMN disk jsonb,
  ADD COLUMN disk_low_at timestamp with time zone,
  ADD COLUMN disk_low_recorded_at timestamp with time zone;

-- What an Allocation reserves of its machine's disk: its Environment's
-- storageMb, counted against the machine's total less its floor.
ALTER TABLE execution_allocations
  ADD COLUMN reserved_storage_mb integer NOT NULL DEFAULT 0
    CHECK (reserved_storage_mb >= 0);
