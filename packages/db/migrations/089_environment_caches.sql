-- Read-only caches that only a trusted fill writes (ADR 0334). Each row is
-- one fill of one Environment cache on one machine; the machine's copy of a
-- cache is its succeeded fill with the highest generation. Marking a fill
-- succeeded publishes its generation, in one statement.
CREATE SEQUENCE environment_cache_generations;

CREATE TABLE environment_cache_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  cache_name text NOT NULL,
  -- The machine whose copy it fills; null until a request that found no
  -- copy anywhere is placed.
  worker_node_id text REFERENCES worker_nodes(id) ON DELETE CASCADE,
  -- A published revision; null fills the published main when it starts.
  commit_sha char(40),
  reason text NOT NULL CHECK (reason IN ('requested', 'first-use')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'evicted')),
  -- Names this attempt's volume on the machine; a new one per attempt, so
  -- an attempt never writes into what an earlier one left.
  generation bigint,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  -- The replica running it holds it until then, renewing as it runs.
  claimed_until timestamptz,
  allocation_id uuid,
  error text,
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- When a sandbox last mounted this generation; eviction counts from it.
  last_used_at timestamptz
);

CREATE INDEX idx_environment_cache_fills_copies
  ON environment_cache_fills(project_id, environment_name, cache_name,
    worker_node_id, generation DESC)
  WHERE status = 'succeeded';
CREATE INDEX idx_environment_cache_fills_due
  ON environment_cache_fills(created_at)
  WHERE status IN ('queued', 'running');
-- One fill runs per cache and machine, on any replica.
CREATE UNIQUE INDEX uq_environment_cache_fills_running
  ON environment_cache_fills(project_id, environment_name, cache_name,
    worker_node_id)
  WHERE status = 'running';
-- One waits per cache and machine: a request while one waits joins it.
CREATE UNIQUE INDEX uq_environment_cache_fills_queued
  ON environment_cache_fills(project_id, environment_name, cache_name,
    worker_node_id)
  WHERE status = 'queued' AND worker_node_id IS NOT NULL;

-- A workflow's fill request, kept per idempotency key so a retry answers
-- with the fills it started rather than starting more.
CREATE TABLE environment_cache_requests (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  environment_name text NOT NULL,
  cache_name text NOT NULL,
  commit_sha char(40),
  fill_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, idempotency_key)
);
