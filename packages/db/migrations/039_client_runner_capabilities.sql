-- A member runner says what its sandboxes can be given (ADR 0176): images,
-- image builds, containers, an enforced egress policy. Environments that
-- need one are placed on the member's computer only when it offers it.
ALTER TABLE client_runners ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]';
