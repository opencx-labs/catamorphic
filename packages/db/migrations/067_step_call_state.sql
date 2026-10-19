-- A step that called a child workflow with { state } (ADR 0260) keeps that
-- state while it waits; when the child ends, the next step receives
-- { result, state }. Host and connection calls finish within their step and
-- need no column.
ALTER TABLE workflow_step_attempts
    ADD COLUMN call_state_present boolean NOT NULL DEFAULT false,
    ADD COLUMN call_state jsonb;
