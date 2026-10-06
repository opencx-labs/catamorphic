-- A chat whose workspace has held project secrets (ADR 0206) masks, in
-- every later turn and in its forks, every value it could hold: when it
-- first held one, and a sealed record (a credential vault reference) of
-- every value ever delivered to it, so a rotated value stays masked.
ALTER TABLE agent_sessions ADD COLUMN secrets_held_at timestamptz;
ALTER TABLE agent_sessions ADD COLUMN secrets_delivered_ref text;
