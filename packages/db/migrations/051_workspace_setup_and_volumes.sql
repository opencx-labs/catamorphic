-- Workspaces keep what members build (ADR 0207).
--
-- An exclusive volume (a Docker data root, a database) is mounted into one
-- sandbox at a time on its machine. Each hold names the Allocation whose
-- sandbox mounts it; a sandbox created while another holds the key gets an
-- empty temporary volume instead. `node` is the machine: a worker node's
-- id, `client:<runner id>` for a member's runner, or `binding:<id>` for a
-- binding that names no node.
CREATE TABLE volume_holds (
    node text NOT NULL,
    volume_key text NOT NULL,
    allocation_id uuid NOT NULL REFERENCES execution_allocations(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (node, volume_key)
);
CREATE INDEX volume_holds_allocation ON volume_holds (allocation_id);

-- A hold ends with its sandbox: when the Allocation's capacity is released
-- (its sandbox destroyed, by cleanup, an operator, or node recovery), or,
-- for an Allocation on no node whose sandbox its machine keeps itself, when
-- the Allocation is released. Every path that ends an Allocation passes
-- through one of these updates, so no hold outlives its sandbox's lease.
CREATE OR REPLACE FUNCTION release_volume_holds() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM volume_holds WHERE allocation_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER execution_allocations_volume_holds
    AFTER UPDATE OF status, capacity_released_at ON execution_allocations
    FOR EACH ROW
    WHEN (
        NEW.capacity_released_at IS NOT NULL
        OR (NEW.status <> 'active' AND NEW.worker_node_id IS NULL)
    )
    EXECUTE FUNCTION release_volume_holds();

-- A member's own setup command (ADR 0207), from their
-- `.work/personal/environment.json`: not secret, but the member's alone,
-- like their files. It runs only in their own chats.
CREATE TABLE personal_environment_setups (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    external_user_id text NOT NULL,
    command text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (tenant_id, project_id, external_user_id)
);
