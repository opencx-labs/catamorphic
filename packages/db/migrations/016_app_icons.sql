-- Presentation metadata, independent of immutable app source and builds.
-- Unknown future names deliberately remain readable by older hosts.
ALTER TABLE apps ADD COLUMN icon text;
ALTER TABLE apps ADD COLUMN title text;
