-- Models through the gateway (ADR 0180): the tokens each model call a
-- sandbox harness made through the gateway used, per session and agent
-- turn, for accounting. Never the prompt or the answer.
CREATE TABLE model_usage (
    id bigserial PRIMARY KEY,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_session_id uuid,
    turn_id uuid,
    allocation_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    alias text NOT NULL,
    endpoint text NOT NULL,
    model text,
    input_tokens bigint DEFAULT 0 NOT NULL,
    cached_input_tokens bigint DEFAULT 0 NOT NULL,
    cache_creation_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    reasoning_tokens bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX model_usage_session_turn
    ON model_usage (agent_session_id, turn_id);
