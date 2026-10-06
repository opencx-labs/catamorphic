-- Machine rules (ADR 0204): a machine leaves its rule only once its
-- platform confirmed it is gone. Until `machine_destroyed_at` is set, a
-- revoked rule machine is still being destroyed, whether or not its
-- platform reference was ever recorded.
ALTER TABLE work_workers
    ADD COLUMN machine_destroyed_at timestamp with time zone;

-- What went wrong with a rule's machines in the latest pass, for its
-- status; cleared by a pass that acts on the rule without failing.
ALTER TABLE work_machine_rules
    ADD COLUMN last_failure text,
    ADD COLUMN last_failure_at timestamp with time zone;
