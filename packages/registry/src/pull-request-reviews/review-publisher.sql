-- Application-owned tables. Apply once to the publisher's external Postgres.
-- No Catamorphic schema or migration is involved.
CREATE SCHEMA IF NOT EXISTS work_review_publication;
CREATE TABLE IF NOT EXISTS work_review_publication.pulls (
  scope text PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS work_review_publication.verdicts (
  scope text NOT NULL,
  commit_sha text NOT NULL,
  strength integer NOT NULL CHECK (strength BETWEEN 1 AND 3),
  check_plan jsonb,
  PRIMARY KEY (scope, commit_sha)
);
CREATE TABLE IF NOT EXISTS work_review_publication.effects (
  id text PRIMARY KEY,
  scope text NOT NULL,
  commit_sha text NOT NULL,
  turn_id text NOT NULL,
  run_id text NOT NULL,
  action text NOT NULL,
  input jsonb NOT NULL,
  input_digest text NOT NULL,
  stamp text NOT NULL,
  state text NOT NULL CHECK (state IN ('uncertain', 'received')),
  receipt jsonb
);
CREATE INDEX IF NOT EXISTS review_uncertain_effects
  ON work_review_publication.effects (scope) WHERE state = 'uncertain';
