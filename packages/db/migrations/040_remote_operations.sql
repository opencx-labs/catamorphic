-- One queue for every remote executor (ADR 0187): enrolled workers
-- (ADR 0164) and members' This machine runners (ADR 0098) receive sandbox
-- operations the same way. `executor` names the target (`node:<id>` or
-- `client:<id>`); `lease_token` fences it; `poll_id` is the poll that took an
-- operation, so a poll retried after its response was lost receives the same
-- operation again instead of losing it. Rows are transient: the queue drops
-- them once settled or abandoned, and in-flight rows do not survive this
-- upgrade (their controllers already fail them as uncertain).
DROP TABLE worker_node_jobs;
DROP TABLE client_runner_jobs;

CREATE TABLE remote_operations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    executor text NOT NULL,
    lease_token uuid NOT NULL,
    poll_id uuid,
    operation jsonb NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    response jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT remote_operations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);

CREATE INDEX idx_remote_operations_pending ON remote_operations USING btree (executor, created_at) WHERE (status = 'pending'::text);
CREATE UNIQUE INDEX idx_remote_operations_poll ON remote_operations USING btree (executor, poll_id) WHERE (poll_id IS NOT NULL);
