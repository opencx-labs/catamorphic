-- No cross-replica state in replica memory (ADR 0193).

-- Each process renews every running turn it holds, and reads their
-- cancellations, in one statement a second.
CREATE INDEX agent_turns_running_lease_owner
    ON agent_turns (lease_owner)
    WHERE status = 'running';

-- Work one replica does for all of them (a publish, a runtime's creation,
-- a project's sync): a named claim with an expiry. A lapsed claim may be
-- taken by anyone.
CREATE TABLE replica_claims (
    name text PRIMARY KEY,
    holder text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

-- A model call's usage row opens with the call and settles with its answer,
-- so a turn's totals wait for calls streaming through any replica.
ALTER TABLE model_usage ADD COLUMN settled_at timestamp with time zone;

UPDATE model_usage SET settled_at = created_at;

CREATE INDEX model_usage_open
    ON model_usage (agent_session_id, turn_id)
    WHERE settled_at IS NULL;

-- A turn parked on a question its harness holds (ADR 0193): claimed, its
-- lease renewed, its harness idle until the answer arrives.
ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_phase_check;

ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_phase_check
    CHECK (phase IN ('preparing', 'working', 'waiting', 'saving', 'parked'));
