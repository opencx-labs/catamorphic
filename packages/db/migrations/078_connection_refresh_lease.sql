-- One refresher at a time per connection, across every replica (ADR 0316).
-- Single-use refresh tokens are spent by the first exchange, so a second
-- concurrent exchange fails, and reuse detection can revoke the first. The
-- holder sets these before calling the provider and clears them when it
-- publishes or gives up; a lapsed lease lets the next caller take over, and
-- the holder token keeps a taken-over holder from publishing or expiring.
ALTER TABLE connections ADD COLUMN refresh_lease_until timestamptz;
ALTER TABLE connections ADD COLUMN refresh_lease_holder text;
