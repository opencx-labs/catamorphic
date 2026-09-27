-- Who answers an unattended chat's escalations (ADR 0176): the members and
-- project roles an automation named when it delivered into the chat.
ALTER TABLE agent_sessions ADD COLUMN approvers jsonb;
