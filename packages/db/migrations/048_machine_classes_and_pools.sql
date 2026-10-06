-- Machine classes, pools and retention (ADR 0205).

-- The machine reconciler runs under a replica claim (ADR 0193) named for
-- its tenant; its own lease table goes.
DROP TABLE work_machine_reconciler;

-- A pooled machine is one the operator enrolled with "pool": true. It
-- takes no work until a machine rule assigns it, recorded as the rule
-- (`machine_rule`) and either the member it serves (`machine_member`, a
-- user id) or its place among the group's shared machines (`machine_slot`).
ALTER TABLE work_worker_enrollments
    ADD COLUMN pool boolean DEFAULT false NOT NULL;

ALTER TABLE work_workers
    ADD COLUMN pool boolean DEFAULT false NOT NULL,
    ADD COLUMN machine_member text,
    ADD COLUMN machine_slot integer,
    -- A released machine serves nobody at once and keeps its disk for its
    -- rule's retention (`retain_days`, recorded so it outlives the rule);
    -- then it is destroyed, or reset and returned to its pool.
    ADD COLUMN released_at timestamp with time zone,
    ADD COLUMN retain_days integer;

-- One machine per member or shared place of a rule at a time.
CREATE UNIQUE INDEX uq_work_workers_machine_member
    ON work_workers (tenant_id, machine_rule, machine_member)
    WHERE machine_member IS NOT NULL
      AND released_at IS NULL
      AND revoked_at IS NULL;

CREATE UNIQUE INDEX uq_work_workers_machine_slot
    ON work_workers (tenant_id, machine_rule, machine_slot)
    WHERE machine_slot IS NOT NULL
      AND released_at IS NULL
      AND revoked_at IS NULL;
