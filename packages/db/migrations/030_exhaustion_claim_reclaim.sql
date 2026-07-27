-- Make the exhaustion claim crash-safe by splitting claim from receipt.
--
-- `exhaustion_handled_at` was stamped before the terminal handler ran, so a
-- crash between stamp and handler left the job permanently "handled" with no
-- side effect: the run never failed terminally, and the retention guard then
-- kept its whole tree forever. The stamp now acts as a lease that expires, and
-- a separate receipt marks completion. The sweep index carries only rows
-- without a receipt, so reclaim scans stay proportional to in-flight
-- exhaustion work rather than to failure history.
ALTER TABLE execution_jobs
  ADD COLUMN exhaustion_handled boolean NOT NULL DEFAULT false;

UPDATE execution_jobs
SET exhaustion_handled = true
WHERE status = 'failed' AND exhaustion_handled_at IS NOT NULL;

DROP INDEX idx_execution_jobs_unhandled_exhaustion;
CREATE INDEX idx_execution_jobs_unhandled_exhaustion
  ON execution_jobs(completed_at, id)
  WHERE status = 'failed' AND NOT exhaustion_handled;
