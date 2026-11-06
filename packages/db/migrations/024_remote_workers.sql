-- Remote workers (ADR 0164): execution machines without database access.
-- A control-plane instance holds a remote node's lease and forwards sandbox
-- operations to the worker through this queue, fenced by the lease token.
CREATE TABLE worker_node_jobs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    node_id text NOT NULL REFERENCES worker_nodes(id) ON DELETE CASCADE,
    lease_token uuid NOT NULL,
    operation jsonb NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    response jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT worker_node_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);

CREATE INDEX idx_worker_node_jobs_pending ON worker_node_jobs USING btree (node_id, created_at) WHERE (status = 'pending'::text);

-- The Work server's enrolled workers: a name, a hashed machine credential,
-- liveness, and placement policy (ADR 0167): labels Environments select on,
-- whose work the worker takes (`{"everyone": true}` or
-- `{"people": [emails], "groups": [group emails]}`), and whether the people
-- it serves trust each other enough for process isolation. `machine_rule`
-- and `machine_ref` tie a provisioned machine to the rule that made it.
-- The node row in worker_nodes carries descriptor and capacity.
CREATE TABLE work_workers (
    node_id text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    credential_hash text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    access jsonb DEFAULT '{"everyone": true}'::jsonb NOT NULL,
    trusted boolean DEFAULT false NOT NULL,
    machine_rule text,
    machine_ref text,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone
);

CREATE UNIQUE INDEX uq_work_workers_name ON work_workers USING btree (tenant_id, name);

-- One-time enrollment codes an operator hands to a new worker.
CREATE TABLE work_worker_enrollments (
    code_hash text PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    access jsonb DEFAULT '{"everyone": true}'::jsonb NOT NULL,
    trusted boolean DEFAULT false NOT NULL,
    machine_rule text,
    machine_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);

-- Machine rules (ADR 0167): which directory groups get dedicated machines or
-- a shared pool. A reconciler provisions workers to match.
CREATE TABLE work_machine_rules (
    name text NOT NULL,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (tenant_id, name)
);

-- One reconciler at a time across control-plane replicas: a short lease.
CREATE TABLE work_machine_reconciler (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    holder text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);
