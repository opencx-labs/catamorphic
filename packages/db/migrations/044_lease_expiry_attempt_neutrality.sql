-- A lease expiry is not a code failure. On a laptop, the common way a lease
-- dies is the machine sleeping or powering off mid-step; charging those
-- against max_attempts let five lid-closes during one long step fail a run
-- permanently. Expiries get their own counter with its own (generous) cap,
-- so a handler that reliably kills its process still cannot requeue forever,
-- while attempts stay reserved for genuine handler failures.
ALTER TABLE execution_jobs
  ADD COLUMN lease_expiries integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_execution_job_lease_expiries CHECK (lease_expiries >= 0);
