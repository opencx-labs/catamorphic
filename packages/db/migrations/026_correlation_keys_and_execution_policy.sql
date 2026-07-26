-- Correlation keys, named signals, boundary rate blocking, and host-owned
-- per-tenant execution policy.
--
-- Together these let a workflow model a long-lived, per-entity journey that an
-- external event can address without the host maintaining its own
-- entity -> runId mapping, and let the embedder bound what any one tenant may
-- consume from the shared queue and from shared third-party rate budgets.

-- A run may carry a host-meaningful business identity (a contact, an account,
-- a subscription). It is unique among non-terminal runs of the same workflow,
-- which makes it simultaneously an enrollment idempotency key and the address
-- for signal/cancel delivery.
ALTER TABLE workflow_runs
  ADD COLUMN correlation_key varchar(500);

ALTER TABLE workflow_runs
  ADD CONSTRAINT chk_workflow_run_correlation_key
    CHECK (correlation_key IS NULL OR length(correlation_key) > 0);

-- Enrollment idempotency: at most one live run per (workflow, key). Terminal
-- runs are excluded so a contact can be re-enrolled after finishing.
CREATE UNIQUE INDEX uq_workflow_runs_correlation_active
  ON workflow_runs(project_id, workflow_name, correlation_key)
  WHERE correlation_key IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'canceled');

-- Signal/cancel delivery and operator lookup ("show me this contact's journey")
-- span every run for the key, including terminal ones.
CREATE INDEX idx_workflow_runs_correlation_history
  ON workflow_runs(project_id, workflow_name, correlation_key, created_at DESC)
  WHERE correlation_key IS NOT NULL;

-- A pause may be named, which makes it addressable by (run, signal name)
-- instead of only by its surrogate id. Unnamed pauses keep working exactly as
-- before and are resumable only by pause id.
ALTER TABLE workflow_pauses
  ADD COLUMN signal_name varchar(255);

ALTER TABLE workflow_pauses
  ADD CONSTRAINT chk_workflow_pause_signal_name
    CHECK (signal_name IS NULL OR length(signal_name) > 0);

CREATE UNIQUE INDEX uq_workflow_pauses_open_signal
  ON workflow_pauses(run_id, signal_name)
  WHERE signal_name IS NOT NULL AND status = 'open';

-- Observability for shared rate budgets: which step attempts are parked on
-- which buckets, and until when. Set when a reservation is refused, cleared
-- when it is granted.
ALTER TABLE workflow_step_attempts
  ADD COLUMN rate_blocked_until timestamptz,
  ADD COLUMN rate_blocked_keys jsonb;

ALTER TABLE workflow_step_attempts
  ADD CONSTRAINT chk_workflow_step_attempt_rate_block
    CHECK (
      (rate_blocked_until IS NULL AND rate_blocked_keys IS NULL)
      OR
      (rate_blocked_until IS NOT NULL AND jsonb_typeof(rate_blocked_keys) = 'array')
    );

CREATE INDEX idx_workflow_step_attempts_rate_blocked
  ON workflow_step_attempts(rate_blocked_until)
  WHERE rate_blocked_until IS NOT NULL;

-- Host-owned execution policy. The embedder — not the workflow author — decides
-- how much of the shared queue and of shared rate budgets a tenant may consume.
-- A tenant with no row is unconstrained, so this table is purely additive.
CREATE TABLE tenant_execution_policies (
  tenant_id             uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Ceiling on execution jobs this tenant may hold leased at once. NULL is
  -- unlimited. This is the primary noisy-neighbour control.
  max_concurrent_jobs   integer,
  -- Ceiling on simultaneously non-terminal production runs. NULL is unlimited.
  -- Bounds campaign enrollment fan-out.
  max_active_runs       integer,
  -- Relative share of a claim batch. Higher weight lets a tenant take more
  -- jobs per round once every eligible tenant has taken its floor of one.
  queue_weight          integer NOT NULL DEFAULT 1,
  -- Suspends claiming for this tenant without cancelling anything in flight.
  jobs_enabled          boolean NOT NULL DEFAULT true,
  -- Per-bucket overrides keyed by the author's `globalKey`, letting a host tier
  -- tenants against a shared third-party account:
  --   { "whatsapp": { "capacity": 1000, "refillRatePerSecond": 10 } }
  rate_limit_overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tenant_policy_max_concurrent_jobs
    CHECK (max_concurrent_jobs IS NULL OR max_concurrent_jobs > 0),
  CONSTRAINT chk_tenant_policy_max_active_runs
    CHECK (max_active_runs IS NULL OR max_active_runs > 0),
  CONSTRAINT chk_tenant_policy_queue_weight
    CHECK (queue_weight > 0 AND queue_weight <= 1000),
  CONSTRAINT chk_tenant_policy_rate_overrides
    CHECK (jsonb_typeof(rate_limit_overrides) = 'object')
);

-- The claim counts a tenant's leased jobs on every poll.
CREATE INDEX idx_execution_jobs_running_by_tenant
  ON execution_jobs(tenant_id)
  WHERE status = 'running';

-- The claim ranks each tenant's pending jobs by (priority, created_at).
CREATE INDEX idx_execution_jobs_pending_rank
  ON execution_jobs(tenant_id, priority DESC, created_at, id)
  WHERE status = 'pending';

-- Enrollment caps count a tenant's live root runs.
CREATE INDEX idx_workflow_runs_active_by_project
  ON workflow_runs(project_id)
  WHERE parent_run_id IS NULL
    AND status NOT IN ('completed', 'failed', 'canceled');
