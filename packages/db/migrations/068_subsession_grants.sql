-- Subsessions name an agent and its settings, and grants decide (ADR 0270).
-- A child may run read-only, in its harness's own read-only mode; the grant
-- that admitted it replaces the route it was started through: `self`, `*`,
-- or the agent it named.
ALTER TABLE agent_sessions
    ADD COLUMN read_only boolean NOT NULL DEFAULT false;

ALTER TABLE agent_delegations RENAME COLUMN route_id TO grant_agent;
UPDATE agent_delegations
SET grant_agent = CASE
    WHEN grant_agent = 'same-agent' THEN 'self'
    WHEN grant_agent IN ('named', 'any-agent') THEN '*'
    WHEN grant_agent LIKE 'agent:%' THEN substring(grant_agent FROM 7)
    ELSE COALESCE(
        (SELECT agent_id FROM agent_sessions
         WHERE agent_sessions.id = agent_delegations.target_session_id),
        grant_agent)
END;
