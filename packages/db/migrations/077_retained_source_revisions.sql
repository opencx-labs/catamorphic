-- A retained pin identifies the exact accepted source revision a run executes.
-- Earlier journals did not record revision numbers; leave those unknown rather
-- than attributing an old run to the artifact's current mutable revision.
ALTER TABLE session_artifact_revisions ADD COLUMN source_revision integer
  CHECK (source_revision > 0);
ALTER TABLE session_artifact_revisions ALTER COLUMN source_revision SET DEFAULT 1;
