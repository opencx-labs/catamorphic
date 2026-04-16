-- Remove schema-only tables (no application queries; agent routes are stubs).
-- FK order: children before parents.
DROP TABLE IF EXISTS agent_messages CASCADE;
DROP TABLE IF EXISTS agent_sessions CASCADE;
DROP TABLE IF EXISTS project_sandboxes CASCADE;
DROP TABLE IF EXISTS project_members CASCADE;
DROP TABLE IF EXISTS users CASCADE;
