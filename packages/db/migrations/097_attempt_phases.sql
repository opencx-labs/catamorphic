-- How long each part of an attempt's preparation took (ADR 0354).
--
-- phases: an ordered array of { phase, startedAt, endedAt }, written as
-- each phase starts and ends, so a preparation that is stuck shows which
-- phase it is in; one still running has no endedAt. It stays with the
-- attempt after the turn settled.
ALTER TABLE agent_turn_attempts
  ADD COLUMN phases jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT agent_turn_attempts_phases_check
    CHECK (jsonb_typeof(phases) = 'array');

-- waited_since: when the work an Allocation placed started waiting for a
-- machine (ADR 0258), copied from its placement wait in the transaction
-- that ends the wait; null when it was placed at once. The first attempt
-- prepared on the Allocation takes it as its `machine.wait` phase.
ALTER TABLE execution_allocations
  ADD COLUMN waited_since timestamp with time zone;
