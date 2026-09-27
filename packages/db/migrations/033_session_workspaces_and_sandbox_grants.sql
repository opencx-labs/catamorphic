-- A session's workspace has a base (ADR 0178): the ref of the project's
-- linked remote it was asked to start at and the commit that ref named.
-- `workspace` is the base the workspace stands on now; `workspace_move` is a
-- base a later delivery asked for, applied before the chat's next turn.
ALTER TABLE agent_sessions
  ADD COLUMN workspace jsonb,
  ADD COLUMN workspace_move jsonb;

-- Grants reach sandboxes (ADR 0175). A session holds one grant per alias
-- for its harness's connection MCP servers and one written into its
-- sandbox for the Git gateway; renewing one never revokes the other.
ALTER TABLE connection_capability_grants
  ADD COLUMN channel text NOT NULL DEFAULT 'mcp'
    CHECK (channel IN ('mcp', 'sandbox'));
