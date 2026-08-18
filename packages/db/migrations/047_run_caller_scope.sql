-- The caller of a run (ADR 0055): stamped server-side at trigger time from
-- the verified identity, never from `input`. `external_user_id` already
-- names who; this holds the caller's artifact refs (a viewer's grants) so
-- host calls and the documents surface can act AS the caller from inside a
-- workflow. NULL = the run's user is a builder/root of the project (no
-- narrowing). Child runs inherit their parent's caller.

ALTER TABLE workflow_runs ADD COLUMN caller_scope jsonb;
