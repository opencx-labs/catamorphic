-- The published sync (ADR 0170): since when the project's main has not been
-- a fast-forward of its code host's default branch, so accepted changes stop
-- arriving until someone reconciles them. Null while the two converge.
ALTER TABLE projects ADD COLUMN remote_diverged_at timestamptz;
