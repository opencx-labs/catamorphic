-- Subsessions name an agent and its settings, and grants decide (ADR 0270).
-- A child may run read-only, in its harness's own read-only mode; the grant
-- that admitted it replaces the route it was started through.
ALTER TABLE agent_sessions
    ADD COLUMN read_only boolean NOT NULL DEFAULT false;

ALTER TABLE agent_delegations RENAME COLUMN route_id TO grant_agent;
UPDATE agent_delegations SET grant_agent = 'self' WHERE grant_agent = 'same-agent';
