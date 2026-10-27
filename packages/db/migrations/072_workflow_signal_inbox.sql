-- A bounded, run-generation-fenced inbox for named pause delivery (ADR 0291).
CREATE TABLE workflow_signals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    signal_name varchar(255) NOT NULL CHECK (length(signal_name) > 0),
    idempotency_key varchar(255) NOT NULL CHECK (length(idempotency_key) > 0),
    payload_hash char(64) NOT NULL,
    value jsonb,
    status varchar(20) NOT NULL DEFAULT 'buffered'
        CHECK (status IN ('buffered', 'resumed', 'discarded')),
    pause_id uuid UNIQUE REFERENCES workflow_pauses(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (run_id, idempotency_key),
    CHECK (
        (status = 'buffered' AND value IS NOT NULL AND pause_id IS NULL AND resolved_at IS NULL)
        OR (status = 'resumed' AND value IS NULL AND pause_id IS NOT NULL AND resolved_at IS NOT NULL)
        OR (status = 'discarded' AND value IS NULL AND pause_id IS NULL AND resolved_at IS NOT NULL)
    )
);
CREATE INDEX workflow_signals_pending
    ON workflow_signals (run_id, signal_name, sequence) WHERE status = 'buffered';

-- Every completion/recovery/cancellation path shares the run row. Clear values
-- in its transaction, including paths which never reach the coordinator.
CREATE FUNCTION discard_workflow_signals() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    UPDATE workflow_signals SET status = 'discarded', value = NULL, resolved_at = now()
        WHERE run_id = NEW.id AND status = 'buffered';
    RETURN NULL;
END;
$$;
CREATE TRIGGER workflow_runs_discard_signals AFTER UPDATE OF status ON workflow_runs
    FOR EACH ROW WHEN (NEW.status IN ('canceling', 'completed', 'failed', 'canceled'))
    EXECUTE FUNCTION discard_workflow_signals();
