-- Machines are decided and made by host code (ADR 0347), and stop and
-- resume (ADR 0348). One row per machine Work knows, from the moment its
-- intent is recorded until its platform confirmed it gone: the name the
-- host's plan chose (or an operator enrolled by hand), whom it is for, and
-- where Work stands in making, stopping, resuming or destroying it.
CREATE TABLE work_machines (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    -- Made through the host's machines hook; false for a machine an
    -- operator enrolled by hand, which Work never creates, stops or destroys.
    managed boolean DEFAULT false NOT NULL,
    -- The platform's id, once create answered.
    ref text,
    -- The enrollment its create is asked with until it answers: the code is
    -- derived from the server's secret and this nonce, so any replica asks
    -- again with the same code and key, and no code is stored.
    enrollment_nonce text,
    idempotency_key text,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- Who may place work here: a list of { user }, { project } or
    -- { project, key } principals; null for anyone whose role and
    -- Environment allow it.
    serves jsonb,
    trusted boolean DEFAULT false NOT NULL,
    -- Opaque to Work; handed to the hook's verbs.
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    lost_after_minutes integer,
    reason text,
    phase text DEFAULT 'starting' NOT NULL,
    phase_since timestamp with time zone DEFAULT now() NOT NULL,
    -- When the verb its phase repeats (start) answered done.
    verb_done_at timestamp with time zone,
    -- Creates the platform refused in a row, and when the latest was.
    refused_count integer DEFAULT 0 NOT NULL,
    refused_at timestamp with time zone,
    -- The plan no longer names it: it takes no new work.
    dropped_at timestamp with time zone,
    -- When Work called it lost, once per loss.
    lost_at timestamp with time zone,
    -- An operator disabled it: its work waits, and it is never lost.
    disabled_at timestamp with time zone,
    -- Its principals change once it is reset: it takes no new work until then.
    reset_pending boolean DEFAULT false NOT NULL,
    reset_serves jsonb,
    -- Why Work cannot do what the plan asks yet.
    notice text,
    last_error text,
    last_error_verb text,
    last_error_at timestamp with time zone,
    destroy_requested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (tenant_id, name),
    CONSTRAINT chk_work_machines_phase CHECK (phase IN ('starting', 'running', 'stopping', 'stopped', 'resuming', 'destroying')),
    CONSTRAINT chk_work_machines_labels CHECK (jsonb_typeof(labels) = 'object'),
    CONSTRAINT chk_work_machines_serves CHECK (serves IS NULL OR jsonb_typeof(serves) = 'array'),
    CONSTRAINT chk_work_machines_options CHECK (jsonb_typeof(options) = 'object')
);

-- Placement reserves capacity under the worker node row lock. A host can
-- pause admission and change its revision without ending the worker's lease.
ALTER TABLE worker_nodes
    ADD COLUMN admission_revision uuid;

-- Every enrolled worker becomes a machine enrolled by hand: Work goes on
-- placing work on it and never destroys what a rule made. Access that named
-- everyone stays open to anyone; projects stay; people and directory groups
-- were emails and group emails, which no longer name anyone, so such a
-- machine serves nobody until its operator (or the plan) says whom it is for.
INSERT INTO work_machines (tenant_id, name, managed, ref, labels, serves, trusted, phase, phase_since, dropped_at)
SELECT
    worker.tenant_id,
    worker.name,
    false,
    worker.machine_ref,
    worker.labels,
    CASE
        WHEN jsonb_exists(worker.access, 'everyone') THEN NULL
        ELSE coalesce(
            (
                SELECT jsonb_agg(jsonb_build_object('project', project.value))
                FROM jsonb_array_elements_text(coalesce(worker.access -> 'projects', '[]'::jsonb)) AS project(value)
            ),
            '[]'::jsonb
        )
    END,
    worker.trusted,
    CASE WHEN worker.last_seen_at IS NULL THEN 'starting' ELSE 'running' END,
    worker.enrolled_at,
    worker.released_at
FROM work_workers AS worker
WHERE worker.revoked_at IS NULL;

UPDATE worker_nodes AS node
SET admission_revision = gen_random_uuid()
FROM work_machines AS machine
WHERE node.tenant_id = machine.tenant_id
  AND node.id = 'worker.' || machine.name
  AND machine.phase = 'running'
  AND machine.dropped_at IS NULL;

DROP INDEX IF EXISTS uq_work_workers_machine_member;
DROP INDEX IF EXISTS uq_work_workers_machine_slot;

ALTER TABLE work_workers
    DROP COLUMN labels,
    DROP COLUMN access,
    DROP COLUMN trusted,
    DROP COLUMN machine_rule,
    DROP COLUMN machine_ref,
    DROP COLUMN pool,
    DROP COLUMN machine_member,
    DROP COLUMN machine_slot,
    DROP COLUMN released_at,
    DROP COLUMN retain_days,
    DROP COLUMN machine_destroyed_at;

-- A code only says which machine it enrolls; the machine's row says the rest.
DELETE FROM work_worker_enrollments WHERE used_at IS NULL;
ALTER TABLE work_worker_enrollments
    DROP COLUMN labels,
    DROP COLUMN access,
    DROP COLUMN trusted,
    DROP COLUMN machine_rule,
    DROP COLUMN machine_ref,
    DROP COLUMN pool;

-- Policy is the host's code: no rules are stored.
DROP TABLE work_machine_rules;

-- What the latest plan said, for the machines listing on every replica: a
-- plan that threw, timed out or answered something invalid changes nothing
-- and is shown here.
CREATE TABLE work_machine_plans (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    planned_at timestamp with time zone,
    error text,
    error_at timestamp with time zone
);

-- Waiting work says which chat it is for (a chat key, so a machine can be
-- for one key), and which machine Work is starting or resuming for it.
ALTER TABLE placement_waits
    ADD COLUMN chat_key text,
    ADD COLUMN machine jsonb,
    ADD CONSTRAINT chk_placement_wait_machine CHECK (machine IS NULL OR jsonb_typeof(machine) = 'object');
