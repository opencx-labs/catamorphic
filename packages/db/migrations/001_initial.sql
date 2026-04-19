CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(255) NOT NULL,
  code        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status        varchar(50) NOT NULL,
  trigger_data  jsonb,
  result        jsonb,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE TABLE workflow_run_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id       varchar(255) NOT NULL,
  name          varchar(255) NOT NULL,
  status        varchar(50) NOT NULL,
  input         jsonb,
  output        jsonb,
  error         text,
  started_at    timestamptz,
  completed_at  timestamptz
);
