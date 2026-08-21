-- Incognito sessions (ADR 0062): a per-session privacy flag. An incognito
-- chat persists locally like any other, but is never mirrored to a linked
-- remote (ADR 0061) and therefore never enters team history or usage.
-- Whether a project's members may open incognito chats is the project's
-- committed policy (`.catamorphic/project.json` `allowIncognito`), honored
-- by clients — a flag on the session, not a mode of the service.
ALTER TABLE agent_sessions
  ADD COLUMN incognito boolean NOT NULL DEFAULT false;
