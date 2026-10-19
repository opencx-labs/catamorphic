-- Work waiting for a machine (ADR 0258): a chat whose admission found no
-- machine with room (`capacity`) or none online and open to it
-- (`unavailable`). Written when admission fails, deleted in the
-- transaction that creates the workload's Allocation, when its chat
-- closes, and once nothing of it is queued. Hosts read it as demand for
-- machines; a row its caller has not tried recently is not demand (the
-- caller stopped). Every time here is the database's.
CREATE TABLE placement_waits (
    root_workload_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workload_kind text NOT NULL,
    environment_name text NOT NULL,
    -- The Environment's pool selector: node labels that must all match.
    pool jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Whose work it is; null for the project's own (a project chat).
    owner text,
    -- What a machine must offer it: { resources, capabilities }.
    requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason text NOT NULL,
    waiting_since timestamp with time zone DEFAULT now() NOT NULL,
    last_tried_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Admission is not tried again before this.
    retry_at timestamp with time zone DEFAULT now() NOT NULL,
    -- The work gives up waiting then; null waits as long as it is queued.
    expires_at timestamp with time zone,
    CONSTRAINT chk_placement_wait_kind CHECK (workload_kind IN ('agent', 'workflow')),
    CONSTRAINT chk_placement_wait_reason CHECK (reason IN ('capacity', 'unavailable')),
    CONSTRAINT chk_placement_wait_pool CHECK (jsonb_typeof(pool) = 'object'),
    CONSTRAINT chk_placement_wait_requirements CHECK (jsonb_typeof(requirements) = 'object')
);

-- Demand: a tenant's waits tried recently.
CREATE INDEX placement_waits_demand ON placement_waits (tenant_id, last_tried_at);
