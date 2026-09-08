-- Catamorphic schema baseline. Generated from the pre-release migration history.
-- Keep this schema-agnostic: migrateToLatest sets the target search_path.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE active_run_invocations (
    invocation_id character varying(255) NOT NULL,
    workflow_run_id uuid NOT NULL,
    workflow_step_attempt_id uuid,
    execution_job_id uuid NOT NULL,
    lease_token uuid NOT NULL,
    lease_generation bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_active_run_invocation_lease_generation CHECK ((lease_generation >= 0))
);

CREATE TABLE agent_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    role character varying(20) NOT NULL,
    content text NOT NULL,
    commit_sha character(40),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    seq bigint NOT NULL,
    author_kind character varying(20) DEFAULT 'user'::character varying NOT NULL,
    author_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    delivery_mode character varying(20) DEFAULT 'next_turn'::character varying NOT NULL,
    idempotency_key character varying(500),
    CONSTRAINT chk_agent_message_author_kind CHECK (((author_kind)::text = ANY ((ARRAY['user'::character varying, 'agent'::character varying, 'workflow'::character varying, 'watcher'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT chk_agent_message_delivery_mode CHECK (((delivery_mode)::text = ANY ((ARRAY['message_only'::character varying, 'next_turn'::character varying, 'interrupt'::character varying])::text[]))),
    CONSTRAINT chk_agent_message_role CHECK (((role)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying, 'system'::character varying])::text[])))
);

ALTER TABLE agent_messages ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME agent_messages_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE agent_runtime_events (
    session_id uuid NOT NULL,
    sequence bigint NOT NULL,
    event_id text NOT NULL,
    turn_id text,
    provider_payload_ref text,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_runtime_events_sequence_check CHECK ((sequence > 0))
);

CREATE TABLE agent_runtime_requests (
    session_id uuid NOT NULL,
    request_id text NOT NULL,
    turn_id text,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone,
    response jsonb,
    resolved_by_external_user_id character varying(255),
    resolved_at timestamp with time zone,
    revision integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_runtime_requests_kind_check CHECK ((kind = ANY (ARRAY['approval'::text, 'question'::text, 'elicitation'::text]))),
    CONSTRAINT agent_runtime_requests_revision_check CHECK ((revision >= 0)),
    CONSTRAINT agent_runtime_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'resolved'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE agent_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    external_user_id character varying(255) NOT NULL,
    provider character varying(50) NOT NULL,
    provider_session_id character varying(255),
    sandbox_id uuid,
    title character varying(500),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    base_commit_sha character(40),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_id character varying(255),
    model_effort character varying(20),
    system_prompt text,
    icon character varying(80),
    parent_session_id uuid,
    activity character varying(500),
    allocation_id uuid,
    environment_name text,
    authority_host_id character varying(255) DEFAULT 'unassigned'::character varying NOT NULL,
    authority_revision bigint DEFAULT 1 NOT NULL,
    authority_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    mirror_message_count integer DEFAULT 0 NOT NULL,
    handoff_status character varying(20) DEFAULT 'none'::character varying NOT NULL,
    handoff_destination_host_id character varying(255),
    todos jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT chk_agent_session_effort CHECK (((model_effort IS NULL) OR ((model_effort)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'xhigh'::character varying, 'max'::character varying])::text[])))),
    CONSTRAINT chk_agent_session_handoff_status CHECK (((handoff_status)::text = ANY ((ARRAY['none'::character varying, 'pending'::character varying])::text[]))),
    CONSTRAINT chk_agent_session_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'closed'::character varying])::text[]))),
    CONSTRAINT chk_agent_session_todos_array CHECK ((jsonb_typeof(todos) = 'array'::text))
);

CREATE TABLE agent_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    message_id uuid NOT NULL,
    result_message_id uuid,
    delivery_mode character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(255),
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_agent_turn_delivery_mode CHECK (((delivery_mode)::text = ANY ((ARRAY['next_turn'::character varying, 'interrupt'::character varying])::text[]))),
    CONSTRAINT chk_agent_turn_status CHECK (((status)::text = ANY ((ARRAY['queued'::character varying, 'held'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);

CREATE TABLE app_storage (
    app_id uuid NOT NULL,
    external_user_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE app_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id uuid NOT NULL,
    kind character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'building'::character varying NOT NULL,
    commit_sha character varying(64),
    built_by_external_user_id character varying(255) NOT NULL,
    bundle_key text,
    css_key text,
    bundle_bytes bigint,
    allowed_workflows jsonb,
    error text,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    published_at timestamp with time zone,
    workflow_shapes jsonb,
    CONSTRAINT chk_active_is_published CHECK (((NOT is_active) OR ((kind)::text = 'published'::text))),
    CONSTRAINT chk_app_version_kind CHECK (((kind)::text = ANY ((ARRAY['preview'::character varying, 'published'::character varying])::text[]))),
    CONSTRAINT chk_app_version_status CHECK (((status)::text = ANY ((ARRAY['building'::character varying, 'ready'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT chk_published_has_sha CHECK ((((kind)::text <> 'published'::text) OR (commit_sha IS NOT NULL)))
);

CREATE TABLE apps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_app_name CHECK (((name)::text ~ '^[a-z0-9][a-z0-9-]*$'::text))
);

CREATE TABLE batch_execution_states (
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    source_snapshot jsonb,
    source_cursor jsonb,
    source_consistency character varying(20),
    estimated_count bigint,
    discovered_count bigint DEFAULT 0 NOT NULL,
    completed_count bigint DEFAULT 0 NOT NULL,
    failed_count bigint DEFAULT 0 NOT NULL,
    skipped_count bigint DEFAULT 0 NOT NULL,
    failure_policy jsonb,
    source_done boolean DEFAULT false NOT NULL,
    source_page_queued boolean DEFAULT false NOT NULL,
    sink_state jsonb,
    sink_artifact jsonb,
    sink_completed_chunks bigint DEFAULT 0 NOT NULL,
    sink_total_chunks bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_snapshot_present boolean DEFAULT false NOT NULL,
    source_cursor_present boolean DEFAULT false NOT NULL,
    sink_state_present boolean DEFAULT false NOT NULL,
    sink_concurrency integer DEFAULT 1 NOT NULL,
    CONSTRAINT chk_batch_completed_count CHECK ((completed_count >= 0)),
    CONSTRAINT chk_batch_discovered_count CHECK ((discovered_count >= 0)),
    CONSTRAINT chk_batch_estimated_count CHECK (((estimated_count IS NULL) OR (estimated_count >= 0))),
    CONSTRAINT chk_batch_failed_count CHECK ((failed_count >= 0)),
    CONSTRAINT chk_batch_sink_chunk_progress CHECK ((sink_completed_chunks <= sink_total_chunks)),
    CONSTRAINT chk_batch_sink_completed_chunks CHECK ((sink_completed_chunks >= 0)),
    CONSTRAINT chk_batch_sink_concurrency CHECK ((sink_concurrency >= 1)),
    CONSTRAINT chk_batch_sink_state_presence CHECK ((sink_state_present = (sink_state IS NOT NULL))),
    CONSTRAINT chk_batch_sink_total_chunks CHECK ((sink_total_chunks >= 0)),
    CONSTRAINT chk_batch_skipped_count CHECK ((skipped_count >= 0)),
    CONSTRAINT chk_batch_source_consistency CHECK (((source_consistency IS NULL) OR ((source_consistency)::text = ANY ((ARRAY['snapshot'::character varying, 'bounded'::character varying, 'best_effort'::character varying])::text[])))),
    CONSTRAINT chk_batch_source_cursor_presence CHECK ((source_cursor_present = (source_cursor IS NOT NULL))),
    CONSTRAINT chk_batch_source_snapshot_presence CHECK ((source_snapshot_present = (source_snapshot IS NOT NULL)))
);

CREATE TABLE batch_item_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    item_id uuid NOT NULL,
    node_id character varying(255) NOT NULL,
    occurrence integer DEFAULT 0 NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(20) NOT NULL,
    input jsonb,
    output jsonb,
    error text,
    attempt integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    input_present boolean DEFAULT false NOT NULL,
    output_present boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_batch_item_step_attempt CHECK ((attempt >= 1)),
    CONSTRAINT chk_batch_item_step_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_batch_item_step_input_presence CHECK ((input_present = (input IS NOT NULL))),
    CONSTRAINT chk_batch_item_step_occurrence CHECK ((occurrence >= 0)),
    CONSTRAINT chk_batch_item_step_output_presence CHECK ((output_present = (output IS NOT NULL))),
    CONSTRAINT chk_batch_item_step_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'skipped'::character varying, 'waiting'::character varying])::text[])))
);

CREATE TABLE batch_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    item_key character varying(500) NOT NULL,
    source_order bigint NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    value jsonb NOT NULL,
    output jsonb,
    error text,
    current_node_id character varying(255),
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_batch_item_attempt CHECK ((attempt >= 0)),
    CONSTRAINT chk_batch_item_completion CHECK (((((status)::text = ANY ((ARRAY['succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_batch_item_source_order CHECK ((source_order >= 0)),
    CONSTRAINT chk_batch_item_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'waiting'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying, 'canceled'::character varying])::text[])))
);

CREATE TABLE batch_sink_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    chunk_key character varying(500) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    first_order bigint NOT NULL,
    last_order bigint NOT NULL,
    item_count integer NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    acknowledgement jsonb,
    artifact jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_batch_sink_chunk_attempt CHECK ((attempt >= 0)),
    CONSTRAINT chk_batch_sink_chunk_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_batch_sink_chunk_item_count CHECK ((item_count > 0)),
    CONSTRAINT chk_batch_sink_chunk_order CHECK (((first_order >= 0) AND (last_order >= first_order))),
    CONSTRAINT chk_batch_sink_chunk_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);

CREATE TABLE batch_step_invocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    node_id character varying(255) NOT NULL,
    function_name character varying(255) NOT NULL,
    compatibility_key character(64) NOT NULL,
    policy jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    closes_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    member_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT chk_batch_step_invocation_attempt CHECK ((attempt >= 0)),
    CONSTRAINT chk_batch_step_invocation_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_batch_step_invocation_policy CHECK ((jsonb_typeof(policy) = 'object'::text)),
    CONSTRAINT chk_batch_step_invocation_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])))
);

CREATE TABLE batch_step_members (
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    item_id uuid NOT NULL,
    member_key character varying(500) NOT NULL,
    input jsonb,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    output jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    occurrence integer DEFAULT 0 NOT NULL,
    input_present boolean DEFAULT true NOT NULL,
    output_present boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_batch_step_member_completion CHECK (((((status)::text = 'pending'::text) AND (completed_at IS NULL)) OR (((status)::text <> 'pending'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT chk_batch_step_member_input_presence CHECK ((input_present = (input IS NOT NULL))),
    CONSTRAINT chk_batch_step_member_occurrence CHECK ((occurrence >= 0)),
    CONSTRAINT chk_batch_step_member_output_presence CHECK ((output_present = (output IS NOT NULL))),
    CONSTRAINT chk_batch_step_member_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'skipped'::character varying, 'unresolved'::character varying])::text[])))
);

CREATE TABLE connection_action_requirements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    execution_job_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    environment_name text NOT NULL,
    alias text NOT NULL,
    external_user_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT chk_connection_action_requirement_resolution CHECK ((((status = 'pending'::text) AND (resolved_at IS NULL)) OR ((status = 'resolved'::text) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT connection_action_requirements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'resolved'::text])))
);

CREATE TABLE connection_audit_events (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid,
    connection_id uuid,
    allocation_id uuid,
    actor_external_user_id text,
    event_type text NOT NULL,
    outcome text NOT NULL,
    action text,
    arguments_digest text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connection_audit_events_outcome_check CHECK ((outcome = ANY (ARRAY['allowed'::text, 'denied'::text, 'error'::text])))
);

ALTER TABLE connection_audit_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME connection_audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE connection_authorization_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    environment_name text NOT NULL,
    alias text NOT NULL,
    provider_kind text NOT NULL,
    external_user_id text NOT NULL,
    state_hash text NOT NULL,
    private_state_ref text,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    reauthorize_connection_id uuid,
    CONSTRAINT connection_authorization_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completing'::text, 'completed'::text, 'expired'::text, 'canceled'::text])))
);

CREATE TABLE connection_capability_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    agent_session_id uuid,
    binding_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    token_hash text NOT NULL,
    capabilities jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid,
    provider_kind text NOT NULL,
    principal_kind text NOT NULL,
    owner_external_user_id text,
    label text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    credential_ref text,
    account_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_connection_principal_owner CHECK ((((principal_kind = 'member'::text) AND (owner_external_user_id IS NOT NULL)) OR ((principal_kind <> 'member'::text) AND (owner_external_user_id IS NULL)))),
    CONSTRAINT chk_connection_project_scope CHECK ((((principal_kind = 'project_service'::text) AND (project_id IS NOT NULL)) OR (principal_kind <> 'project_service'::text))),
    CONSTRAINT connections_principal_kind_check CHECK ((principal_kind = ANY (ARRAY['member'::text, 'project_service'::text, 'tenant_service'::text]))),
    CONSTRAINT connections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'expired'::text, 'revoked'::text])))
);

CREATE TABLE deployment_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    commit_sha character(40) NOT NULL,
    artifact_digest character(64) NOT NULL,
    plugin_digest character(64) NOT NULL,
    transform_version character varying(100) NOT NULL,
    runtime_version character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_deployment_artifact_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'building'::character varying, 'ready'::character varying, 'failed'::character varying, 'retired'::character varying])::text[])))
);

CREATE TABLE deployment_runtimes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    artifact_id uuid NOT NULL,
    provider_id character varying(255) NOT NULL,
    replica_index integer DEFAULT 0 NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    status character varying(20) DEFAULT 'creating'::character varying NOT NULL,
    endpoint_metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    sandbox_id character varying(255) NOT NULL,
    binding_id text DEFAULT 'default'::text NOT NULL,
    CONSTRAINT chk_deployment_runtime_status CHECK (((status)::text = ANY ((ARRAY['creating'::character varying, 'starting'::character varying, 'ready'::character varying, 'draining'::character varying, 'stopped'::character varying, 'failed'::character varying])::text[])))
);

CREATE TABLE environment_connection_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    environment_name text NOT NULL,
    alias text NOT NULL,
    provider_kind text NOT NULL,
    principal_kinds jsonb NOT NULL,
    service_connection_id uuid,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE execution_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    environment_name text NOT NULL,
    binding_id text NOT NULL,
    workload_kind text NOT NULL,
    root_workload_id uuid NOT NULL,
    worker_node_id text,
    policy_snapshot jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT chk_execution_allocation_release CHECK ((((status = 'active'::text) AND (released_at IS NULL)) OR ((status = 'released'::text) AND (released_at IS NOT NULL)))),
    CONSTRAINT execution_allocations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'released'::text]))),
    CONSTRAINT execution_allocations_workload_kind_check CHECK ((workload_kind = ANY (ARRAY['agent'::text, 'workflow'::text])))
);

CREATE TABLE execution_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    workflow_step_attempt_id uuid,
    kind character varying(50) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    leased_by character varying(255),
    lease_token uuid,
    lease_generation bigint DEFAULT 0 NOT NULL,
    heartbeat_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    dedupe_key character varying(500),
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    exhaustion_handled_at timestamp with time zone,
    exhaustion_handled boolean DEFAULT false NOT NULL,
    lease_expiries integer DEFAULT 0 NOT NULL,
    CONSTRAINT chk_execution_job_attempt CHECK ((attempt >= 0)),
    CONSTRAINT chk_execution_job_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_execution_job_lease CHECK (((((status)::text = 'running'::text) AND (leased_by IS NOT NULL) AND (lease_token IS NOT NULL) AND (heartbeat_at IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR (((status)::text <> 'running'::text) AND (leased_by IS NULL) AND (lease_token IS NULL) AND (heartbeat_at IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT chk_execution_job_lease_expiries CHECK ((lease_expiries >= 0)),
    CONSTRAINT chk_execution_job_lease_generation CHECK ((lease_generation >= 0)),
    CONSTRAINT chk_execution_job_max_attempts CHECK ((max_attempts >= 1)),
    CONSTRAINT chk_execution_job_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])))
)
WITH (fillfactor='85');

CREATE TABLE member_connection_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    project_id uuid NOT NULL,
    environment_name text NOT NULL,
    alias text NOT NULL,
    external_user_id text NOT NULL,
    connection_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE memberships (
    project_id uuid NOT NULL,
    external_user_id text NOT NULL,
    roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    grants jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE notification_deliveries (
    event_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(255),
    lease_expires_at timestamp with time zone,
    last_error text,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_notification_delivery_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'leased'::character varying, 'delivered'::character varying, 'retired'::character varying])::text[])))
);

CREATE TABLE project_event_monitors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    source_kind character varying(100) NOT NULL,
    source_key character varying(500) NOT NULL,
    owner_external_user_id character varying(255) NOT NULL,
    placement character varying(20) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    cursor jsonb,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    poll_interval_seconds integer DEFAULT 30 NOT NULL,
    next_poll_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(255),
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_project_event_monitor_placement CHECK (((placement)::text = ANY ((ARRAY['local'::character varying, 'remote'::character varying, 'any'::character varying])::text[]))),
    CONSTRAINT chk_project_event_monitor_poll_interval CHECK (((poll_interval_seconds >= 5) AND (poll_interval_seconds <= 86400))),
    CONSTRAINT chk_project_event_monitor_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'stopped'::character varying])::text[])))
);

CREATE TABLE project_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence bigint NOT NULL,
    project_id uuid NOT NULL,
    source character varying(100) NOT NULL,
    kind character varying(200) NOT NULL,
    external_id character varying(500) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    payload jsonb NOT NULL
);

ALTER TABLE project_events ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME project_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE project_plugins (
    project_id uuid NOT NULL,
    package_name character varying(255) NOT NULL,
    source character varying(20) DEFAULT 'local'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_plugin_source CHECK (((source)::text = 'local'::text))
);

CREATE TABLE project_sandboxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    provider_id character varying(255) NOT NULL,
    sandbox_type character varying(20) NOT NULL,
    commit_sha character(40),
    external_user_id character varying(255),
    status character varying(20) DEFAULT 'creating'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_dev_has_user CHECK ((((sandbox_type)::text <> 'dev'::text) OR (external_user_id IS NOT NULL))),
    CONSTRAINT chk_exec_has_sha CHECK ((((sandbox_type)::text <> 'execution'::text) OR (commit_sha IS NOT NULL))),
    CONSTRAINT chk_sandbox_type CHECK (((sandbox_type)::text = ANY ((ARRAY['execution'::character varying, 'dev'::character varying])::text[])))
);

CREATE TABLE project_secrets (
    project_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stage character varying(20) DEFAULT 'production'::character varying NOT NULL,
    CONSTRAINT chk_project_secret_stage CHECK (((stage)::text = ANY ((ARRAY['test'::character varying, 'production'::character varying])::text[])))
);

CREATE TABLE projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    storage_type character varying(20) DEFAULT 'managed'::character varying NOT NULL,
    remote_url text,
    default_branch character varying(100) DEFAULT 'main'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    remote_branch character varying(255)
);

CREATE TABLE publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    slug text NOT NULL,
    path text NOT NULL,
    audience text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT publications_audience_check CHECK ((audience = ANY (ARRAY['public'::text, 'members'::text])))
);

CREATE TABLE push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    external_user_id character varying(255) NOT NULL,
    endpoint_hash character(64) NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth_secret text NOT NULL,
    user_agent text,
    expires_at timestamp with time zone,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE rate_reservation_buckets (
    tenant_id uuid NOT NULL,
    global_key character varying(500) NOT NULL,
    partition_key character varying(500) DEFAULT ''::character varying NOT NULL,
    capacity numeric NOT NULL,
    tokens numeric NOT NULL,
    refill_rate_per_second numeric NOT NULL,
    refilled_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    blocked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT chk_rate_reservation_capacity CHECK ((capacity > (0)::numeric)),
    CONSTRAINT chk_rate_reservation_refill_rate CHECK ((refill_rate_per_second > (0)::numeric)),
    CONSTRAINT chk_rate_reservation_tokens CHECK (((tokens >= (0)::numeric) AND (tokens <= capacity)))
);

CREATE TABLE schedule_bindings (
    binding_id uuid NOT NULL,
    cron_expression character varying(255) NOT NULL,
    timezone character varying(100) NOT NULL,
    next_fire_at timestamp with time zone NOT NULL,
    last_scheduled_for timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE schedule_occurrences (
    binding_id uuid NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    run_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(255),
    lease_expires_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_schedule_occurrence_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'leased'::character varying, 'enrolled'::character varying, 'skipped'::character varying, 'failed'::character varying])::text[])))
);

CREATE TABLE session_mailbox_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    session_id uuid NOT NULL,
    source_host_id character varying(255) NOT NULL,
    destination_host_id character varying(255) NOT NULL,
    authority_revision bigint NOT NULL,
    message_id uuid DEFAULT gen_random_uuid() NOT NULL,
    content text NOT NULL,
    author_kind character varying(20) NOT NULL,
    author_payload jsonb NOT NULL,
    delivery_mode character varying(20) NOT NULL,
    idempotency_key character varying(500),
    metadata jsonb,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    CONSTRAINT chk_session_mailbox_author_kind CHECK (((author_kind)::text = ANY ((ARRAY['user'::character varying, 'agent'::character varying, 'workflow'::character varying, 'watcher'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT chk_session_mailbox_delivery_mode CHECK (((delivery_mode)::text = ANY ((ARRAY['message_only'::character varying, 'next_turn'::character varying, 'interrupt'::character varying])::text[]))),
    CONSTRAINT chk_session_mailbox_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'acknowledged'::character varying])::text[])))
);

CREATE TABLE session_sync_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    session_id uuid NOT NULL,
    destination_key character varying(500) NOT NULL,
    desired_authority_revision bigint NOT NULL,
    desired_message_count integer NOT NULL,
    acknowledged_authority_revision bigint,
    acknowledged_message_count integer,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(255),
    lease_expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_session_sync_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'leased'::character varying, 'acknowledged'::character varying, 'diverged'::character varying])::text[])))
);

CREATE TABLE stock_project_access_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    external_user_id text NOT NULL,
    email text NOT NULL,
    email_verified boolean NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by_external_user_id text,
    decided_at timestamp with time zone,
    CONSTRAINT stock_project_access_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);

CREATE TABLE stock_project_admission_policies (
    project_id uuid NOT NULL,
    mode text NOT NULL,
    default_role text NOT NULL,
    approved_domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_by_external_user_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_project_admission_policies_mode_check CHECK ((mode = ANY (ARRAY['invitation_only'::text, 'approved_domain'::text, 'request'::text, 'open'::text])))
);

CREATE TABLE stock_project_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    invited_email text,
    roles jsonb NOT NULL,
    grants jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_external_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_by_external_user_id text,
    redeemed_at timestamp with time zone
);

CREATE TABLE store_document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    version integer NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    text_content text,
    bytes bytea,
    blob_key text,
    written_by text NOT NULL,
    written_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE store_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    path text NOT NULL,
    version integer NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    text_content text,
    bytes bytea,
    blob_key text,
    written_by text NOT NULL,
    written_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(text_content, ''::text))) STORED
);

CREATE TABLE tenant_app_policies (
    tenant_id uuid NOT NULL,
    apps_enabled boolean DEFAULT true NOT NULL,
    max_apps_per_project integer,
    max_bundle_bytes bigint,
    allowed_network_origins jsonb DEFAULT '[]'::jsonb NOT NULL,
    workflow_allowlist jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_max_apps_positive CHECK (((max_apps_per_project IS NULL) OR (max_apps_per_project > 0))),
    CONSTRAINT chk_max_bundle_positive CHECK (((max_bundle_bytes IS NULL) OR (max_bundle_bytes > 0)))
);

CREATE TABLE tenant_execution_policies (
    tenant_id uuid NOT NULL,
    max_concurrent_jobs integer,
    max_active_runs integer,
    queue_weight integer DEFAULT 1 NOT NULL,
    jobs_enabled boolean DEFAULT true NOT NULL,
    rate_limit_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retention_days integer,
    CONSTRAINT chk_tenant_policy_max_active_runs CHECK (((max_active_runs IS NULL) OR (max_active_runs > 0))),
    CONSTRAINT chk_tenant_policy_max_concurrent_jobs CHECK (((max_concurrent_jobs IS NULL) OR (max_concurrent_jobs > 0))),
    CONSTRAINT chk_tenant_policy_queue_weight CHECK (((queue_weight > 0) AND (queue_weight <= 1000))),
    CONSTRAINT chk_tenant_policy_rate_overrides CHECK ((jsonb_typeof(rate_limit_overrides) = 'object'::text)),
    CONSTRAINT chk_tenant_policy_retention_days CHECK (((retention_days IS NULL) OR (retention_days > 0)))
);

CREATE TABLE tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE trigger_binding_scans (
    project_id uuid NOT NULL,
    commit_sha character(40) NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE trigger_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    commit_sha character(40) NOT NULL,
    trigger_kind character varying(200) NOT NULL,
    workflow_name character varying(255) NOT NULL,
    config jsonb NOT NULL,
    can_suspend boolean NOT NULL,
    input_parameters jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    input_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    output_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    environment_name text,
    connection_requirements jsonb DEFAULT '[]'::jsonb NOT NULL,
    connection_authorization_snapshot jsonb
);

CREATE TABLE user_notification_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    external_user_id character varying(255) NOT NULL,
    project_id uuid,
    session_id uuid,
    kind character varying(100) NOT NULL,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    route text NOT NULL,
    collapse_key character varying(500) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE watcher_runs (
    watcher_id uuid NOT NULL,
    event_id uuid NOT NULL,
    run_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE watchers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    session_id uuid NOT NULL,
    monitor_id uuid,
    owner_external_user_id character varying(255) NOT NULL,
    owner_identity jsonb NOT NULL,
    workflow_name character varying(255) NOT NULL,
    source_path character varying(1000) NOT NULL,
    remote_branch character varying(500) NOT NULL,
    commit_sha character(40) NOT NULL,
    deployment_artifact_id uuid NOT NULL,
    environment_name character varying(255),
    cursor_sequence bigint DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    expires_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_watcher_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'stopped'::character varying, 'expired'::character varying])::text[])))
);

CREATE TABLE workflow_pauses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    workflow_step_attempt_id uuid NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    state_present boolean DEFAULT false NOT NULL,
    state jsonb,
    timeout_at timestamp with time zone,
    resume_value jsonb,
    resume_idempotency_key character varying(255),
    resume_payload_hash character(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    signal_name character varying(255),
    CONSTRAINT chk_workflow_pause_resolution CHECK (((((status)::text = 'open'::text) AND (resolved_at IS NULL)) OR (((status)::text <> 'open'::text) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT chk_workflow_pause_signal_name CHECK (((signal_name IS NULL) OR (length((signal_name)::text) > 0))),
    CONSTRAINT chk_workflow_pause_state CHECK ((state_present OR (state IS NULL))),
    CONSTRAINT chk_workflow_pause_status CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'resumed'::character varying, 'timed_out'::character varying, 'canceled'::character varying])::text[])))
);

CREATE TABLE workflow_run_events (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    invocation_id character varying(255) NOT NULL,
    sequence integer NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    type character varying(50) NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_workflow_run_event_attempt CHECK ((attempt >= 1)),
    CONSTRAINT chk_workflow_run_event_sequence CHECK ((sequence >= 0))
);

CREATE SEQUENCE workflow_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE workflow_run_events_id_seq OWNED BY workflow_run_events.id;

CREATE TABLE workflow_run_states (
    run_id uuid NOT NULL,
    execution_plan jsonb NOT NULL,
    current_step_index integer DEFAULT 0 NOT NULL,
    current_input jsonb,
    active_workflow_step_attempt_id uuid,
    operator_pause_previous_status character varying(20),
    operator_pause_previous_phase character varying(20),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_workflow_run_current_step CHECK ((current_step_index >= 0)),
    CONSTRAINT chk_workflow_run_execution_plan CHECK ((jsonb_typeof(execution_plan) = 'object'::text)),
    CONSTRAINT chk_workflow_run_operator_pause CHECK ((((operator_pause_previous_status IS NULL) AND (operator_pause_previous_phase IS NULL)) OR (((operator_pause_previous_status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'waiting'::character varying, 'canceling'::character varying])::text[])) AND ((operator_pause_previous_phase)::text = ANY ((ARRAY['execute'::character varying, 'boundary'::character varying, 'source'::character varying, 'process'::character varying, 'sink'::character varying, 'pause'::character varying, 'child'::character varying])::text[])))))
);

CREATE TABLE workflow_run_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    node_id character varying(255) NOT NULL,
    occurrence integer DEFAULT 0 NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    input jsonb,
    output jsonb,
    error text,
    attempt integer DEFAULT 1 NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT chk_workflow_run_step_attempt CHECK ((attempt >= 1)),
    CONSTRAINT chk_workflow_run_step_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_workflow_run_step_occurrence CHECK ((occurrence >= 0)),
    CONSTRAINT chk_workflow_run_step_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);

CREATE TABLE workflow_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    workflow_name character varying(255) NOT NULL,
    provenance jsonb NOT NULL,
    deployment_artifact_id uuid,
    external_user_id character varying(255),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    phase character varying(20) DEFAULT 'execute'::character varying NOT NULL,
    input jsonb,
    result jsonb,
    error text,
    state_version bigint DEFAULT 0 NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    cancel_requested_at timestamp with time zone,
    cancel_reason text,
    parent_run_id uuid,
    parent_workflow_step_attempt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    correlation_key character varying(500),
    caller_scope jsonb,
    allocation_id uuid,
    environment_name text,
    caller_execution_scope jsonb,
    caller_connection_scope jsonb,
    CONSTRAINT chk_workflow_run_attempt CHECK ((attempt >= 0)),
    CONSTRAINT chk_workflow_run_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_workflow_run_correlation_key CHECK (((correlation_key IS NULL) OR (length((correlation_key)::text) > 0))),
    CONSTRAINT chk_workflow_run_not_own_parent CHECK (((parent_run_id IS NULL) OR (parent_run_id <> id))),
    CONSTRAINT chk_workflow_run_parent_link CHECK ((((parent_run_id IS NULL) AND (parent_workflow_step_attempt_id IS NULL)) OR ((parent_run_id IS NOT NULL) AND (parent_workflow_step_attempt_id IS NOT NULL)))),
    CONSTRAINT chk_workflow_run_phase CHECK (((phase)::text = ANY ((ARRAY['execute'::character varying, 'boundary'::character varying, 'source'::character varying, 'process'::character varying, 'sink'::character varying, 'pause'::character varying, 'child'::character varying])::text[]))),
    CONSTRAINT chk_workflow_run_state_version CHECK ((state_version >= 0)),
    CONSTRAINT chk_workflow_run_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'waiting'::character varying, 'paused'::character varying, 'canceling'::character varying, 'completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])))
);

CREATE TABLE workflow_step_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    step_index integer NOT NULL,
    step_node_id character varying(255) NOT NULL,
    executor character varying(20) NOT NULL,
    attempt integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    input jsonb,
    output jsonb,
    error text,
    policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    rate_blocked_until timestamp with time zone,
    rate_blocked_keys jsonb,
    CONSTRAINT chk_workflow_step_attempt_completion CHECK (((((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NOT NULL)) OR (((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NULL)))),
    CONSTRAINT chk_workflow_step_attempt_executor CHECK (((executor)::text = ANY ((ARRAY['boundary'::character varying, 'batch'::character varying])::text[]))),
    CONSTRAINT chk_workflow_step_attempt_index CHECK ((step_index >= 0)),
    CONSTRAINT chk_workflow_step_attempt_number CHECK ((attempt >= 1)),
    CONSTRAINT chk_workflow_step_attempt_policy CHECK ((jsonb_typeof(policy) = 'object'::text)),
    CONSTRAINT chk_workflow_step_attempt_rate_block CHECK ((((rate_blocked_until IS NULL) AND (rate_blocked_keys IS NULL)) OR ((rate_blocked_until IS NOT NULL) AND (jsonb_typeof(rate_blocked_keys) = 'array'::text)))),
    CONSTRAINT chk_workflow_step_attempt_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'waiting'::character varying, 'completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])))
);

ALTER TABLE ONLY workflow_run_events ALTER COLUMN id SET DEFAULT nextval('workflow_run_events_id_seq'::regclass);

ALTER TABLE ONLY active_run_invocations
    ADD CONSTRAINT active_run_invocations_pkey PRIMARY KEY (invocation_id);

ALTER TABLE ONLY agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_runtime_events
    ADD CONSTRAINT agent_runtime_events_pkey PRIMARY KEY (session_id, sequence);

ALTER TABLE ONLY agent_runtime_requests
    ADD CONSTRAINT agent_runtime_requests_pkey PRIMARY KEY (session_id, request_id);

ALTER TABLE ONLY agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_turns
    ADD CONSTRAINT agent_turns_message_id_key UNIQUE (message_id);

ALTER TABLE ONLY agent_turns
    ADD CONSTRAINT agent_turns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app_storage
    ADD CONSTRAINT app_storage_pkey PRIMARY KEY (app_id, external_user_id);

ALTER TABLE ONLY app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY batch_execution_states
    ADD CONSTRAINT batch_execution_states_pkey PRIMARY KEY (run_id, workflow_step_attempt_id);

ALTER TABLE ONLY batch_item_steps
    ADD CONSTRAINT batch_item_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY batch_items
    ADD CONSTRAINT batch_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY batch_sink_chunks
    ADD CONSTRAINT batch_sink_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY batch_step_invocations
    ADD CONSTRAINT batch_step_invocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY batch_step_members
    ADD CONSTRAINT batch_step_members_pkey PRIMARY KEY (run_id, workflow_step_attempt_id, invocation_id, item_id);

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connection_audit_events
    ADD CONSTRAINT connection_audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connection_authorization_attempts
    ADD CONSTRAINT connection_authorization_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connection_authorization_attempts
    ADD CONSTRAINT connection_authorization_attempts_state_hash_key UNIQUE (state_hash);

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_artifacts
    ADD CONSTRAINT deployment_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_runtimes
    ADD CONSTRAINT deployment_runtimes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY environment_connection_bindings
    ADD CONSTRAINT environment_connection_bindin_project_id_environment_name_a_key UNIQUE (project_id, environment_name, alias);

ALTER TABLE ONLY environment_connection_bindings
    ADD CONSTRAINT environment_connection_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY execution_allocations
    ADD CONSTRAINT execution_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY execution_jobs
    ADD CONSTRAINT execution_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY member_connection_attachments
    ADD CONSTRAINT member_connection_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY member_connection_attachments
    ADD CONSTRAINT member_connection_attachments_project_id_environment_name_a_key UNIQUE (project_id, environment_name, alias, external_user_id);

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (project_id, external_user_id);

ALTER TABLE ONLY notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (event_id, subscription_id);

ALTER TABLE ONLY project_event_monitors
    ADD CONSTRAINT project_event_monitors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_event_monitors
    ADD CONSTRAINT project_event_monitors_project_id_source_kind_source_key_ow_key UNIQUE (project_id, source_kind, source_key, owner_external_user_id);

ALTER TABLE ONLY project_events
    ADD CONSTRAINT project_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_events
    ADD CONSTRAINT project_events_project_id_source_external_id_key UNIQUE (project_id, source, external_id);

ALTER TABLE ONLY project_events
    ADD CONSTRAINT project_events_sequence_key UNIQUE (sequence);

ALTER TABLE ONLY project_plugins
    ADD CONSTRAINT project_plugins_pkey PRIMARY KEY (project_id, package_name);

ALTER TABLE ONLY project_sandboxes
    ADD CONSTRAINT project_sandboxes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_secrets
    ADD CONSTRAINT project_secrets_pkey PRIMARY KEY (project_id, stage, name);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY publications
    ADD CONSTRAINT publications_project_id_slug_key UNIQUE (project_id, slug);

ALTER TABLE ONLY push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rate_reservation_buckets
    ADD CONSTRAINT rate_reservation_buckets_pkey PRIMARY KEY (tenant_id, global_key, partition_key);

ALTER TABLE ONLY schedule_bindings
    ADD CONSTRAINT schedule_bindings_pkey PRIMARY KEY (binding_id);

ALTER TABLE ONLY schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_pkey PRIMARY KEY (binding_id, scheduled_for);

ALTER TABLE ONLY session_mailbox_items
    ADD CONSTRAINT session_mailbox_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_sync_intents
    ADD CONSTRAINT session_sync_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY stock_project_access_requests
    ADD CONSTRAINT stock_project_access_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY stock_project_admission_policies
    ADD CONSTRAINT stock_project_admission_policies_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY stock_project_invitations
    ADD CONSTRAINT stock_project_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY store_document_versions
    ADD CONSTRAINT store_document_versions_document_id_version_key UNIQUE (document_id, version);

ALTER TABLE ONLY store_document_versions
    ADD CONSTRAINT store_document_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY store_documents
    ADD CONSTRAINT store_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY store_documents
    ADD CONSTRAINT store_documents_project_id_path_key UNIQUE (project_id, path);

ALTER TABLE ONLY tenant_app_policies
    ADD CONSTRAINT tenant_app_policies_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY tenant_execution_policies
    ADD CONSTRAINT tenant_execution_policies_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY trigger_binding_scans
    ADD CONSTRAINT trigger_binding_scans_pkey PRIMARY KEY (project_id, commit_sha);

ALTER TABLE ONLY trigger_bindings
    ADD CONSTRAINT trigger_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_runtime_events
    ADD CONSTRAINT uq_agent_runtime_event_id UNIQUE (session_id, event_id);

ALTER TABLE ONLY apps
    ADD CONSTRAINT uq_app_project_name UNIQUE (project_id, name);

ALTER TABLE ONLY batch_items
    ADD CONSTRAINT uq_batch_item_key UNIQUE (run_id, workflow_step_attempt_id, item_key);

ALTER TABLE ONLY batch_items
    ADD CONSTRAINT uq_batch_item_order UNIQUE (run_id, workflow_step_attempt_id, source_order);

ALTER TABLE ONLY batch_items
    ADD CONSTRAINT uq_batch_item_scope UNIQUE (run_id, workflow_step_attempt_id, id);

ALTER TABLE ONLY batch_item_steps
    ADD CONSTRAINT uq_batch_item_step_attempt UNIQUE (run_id, workflow_step_attempt_id, item_id, node_id, occurrence, attempt);

ALTER TABLE ONLY batch_sink_chunks
    ADD CONSTRAINT uq_batch_sink_chunk UNIQUE (run_id, workflow_step_attempt_id, chunk_key);

ALTER TABLE ONLY batch_step_invocations
    ADD CONSTRAINT uq_batch_step_invocation_scope UNIQUE (run_id, workflow_step_attempt_id, id);

ALTER TABLE ONLY batch_step_members
    ADD CONSTRAINT uq_batch_step_member_key UNIQUE (run_id, workflow_step_attempt_id, invocation_id, member_key);

ALTER TABLE ONLY deployment_artifacts
    ADD CONSTRAINT uq_deployment_artifact UNIQUE (project_id, artifact_digest);

ALTER TABLE ONLY deployment_runtimes
    ADD CONSTRAINT uq_deployment_runtime UNIQUE (artifact_id, binding_id, replica_index, generation);

ALTER TABLE ONLY project_sandboxes
    ADD CONSTRAINT uq_dev_sandbox UNIQUE NULLS NOT DISTINCT (project_id, sandbox_type, external_user_id);

ALTER TABLE ONLY project_sandboxes
    ADD CONSTRAINT uq_exec_sandbox UNIQUE NULLS NOT DISTINCT (project_id, sandbox_type, commit_sha);

ALTER TABLE ONLY push_subscriptions
    ADD CONSTRAINT uq_push_subscription_endpoint UNIQUE (tenant_id, external_user_id, endpoint_hash);

ALTER TABLE ONLY session_sync_intents
    ADD CONSTRAINT uq_session_sync_destination UNIQUE (session_id, destination_key);

ALTER TABLE ONLY trigger_bindings
    ADD CONSTRAINT uq_trigger_binding UNIQUE (project_id, commit_sha, trigger_kind, workflow_name);

ALTER TABLE ONLY user_notification_events
    ADD CONSTRAINT uq_user_notification_collapse UNIQUE (tenant_id, external_user_id, collapse_key);

ALTER TABLE ONLY workflow_pauses
    ADD CONSTRAINT uq_workflow_pause_step_attempt UNIQUE (run_id, workflow_step_attempt_id);

ALTER TABLE ONLY workflow_run_events
    ADD CONSTRAINT uq_workflow_run_event_sequence UNIQUE (invocation_id, sequence);

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT uq_workflow_run_scope UNIQUE (id, project_id);

ALTER TABLE ONLY workflow_run_steps
    ADD CONSTRAINT uq_workflow_run_step_occurrence UNIQUE (run_id, node_id, occurrence);

ALTER TABLE ONLY workflow_step_attempts
    ADD CONSTRAINT uq_workflow_step_attempt UNIQUE (run_id, step_index, attempt);

ALTER TABLE ONLY workflow_step_attempts
    ADD CONSTRAINT uq_workflow_step_attempt_scope UNIQUE (run_id, id);

ALTER TABLE ONLY user_notification_events
    ADD CONSTRAINT user_notification_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY watcher_runs
    ADD CONSTRAINT watcher_runs_pkey PRIMARY KEY (watcher_id, event_id);

ALTER TABLE ONLY watcher_runs
    ADD CONSTRAINT watcher_runs_run_id_key UNIQUE (run_id);

ALTER TABLE ONLY watchers
    ADD CONSTRAINT watchers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_pauses
    ADD CONSTRAINT workflow_pauses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_run_events
    ADD CONSTRAINT workflow_run_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_run_states
    ADD CONSTRAINT workflow_run_states_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workflow_step_attempts
    ADD CONSTRAINT workflow_step_attempts_pkey PRIMARY KEY (id);

CREATE INDEX idx_active_run_invocations_job ON active_run_invocations USING btree (execution_job_id);

CREATE INDEX idx_active_run_invocations_run ON active_run_invocations USING btree (workflow_run_id, created_at);

CREATE INDEX idx_agent_messages_session ON agent_messages USING btree (session_id);

CREATE INDEX idx_agent_messages_session_seq ON agent_messages USING btree (session_id, seq);

CREATE INDEX idx_agent_runtime_requests_pending_expiry ON agent_runtime_requests USING btree (session_id, expires_at) WHERE (status = 'pending'::text);

CREATE INDEX idx_agent_sessions_allocation ON agent_sessions USING btree (allocation_id) WHERE (allocation_id IS NOT NULL);

CREATE INDEX idx_agent_sessions_parent ON agent_sessions USING btree (parent_session_id);

CREATE INDEX idx_agent_sessions_project ON agent_sessions USING btree (project_id);

CREATE INDEX idx_agent_sessions_resumable ON agent_sessions USING btree (authority_host_id, authority_seen_at) WHERE (((status)::text = 'active'::text) AND (mirror_message_count > 0));

CREATE INDEX idx_agent_turns_claim ON agent_turns USING btree (status, available_at, priority DESC, created_at);

CREATE INDEX idx_agent_turns_session ON agent_turns USING btree (session_id, created_at);

CREATE INDEX idx_app_versions_app ON app_versions USING btree (app_id, created_at DESC);

CREATE INDEX idx_apps_project ON apps USING btree (project_id);

CREATE INDEX idx_batch_item_steps_item ON batch_item_steps USING btree (run_id, workflow_step_attempt_id, item_id, created_at);

CREATE INDEX idx_batch_items_ready ON batch_items USING btree (run_id, workflow_step_attempt_id, status, available_at, source_order) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'waiting'::character varying])::text[]));

CREATE INDEX idx_batch_items_status ON batch_items USING btree (run_id, workflow_step_attempt_id, status);

CREATE INDEX idx_batch_sink_chunks_ready ON batch_sink_chunks USING btree (run_id, workflow_step_attempt_id, status, first_order);

CREATE INDEX idx_batch_step_invocations_ready ON batch_step_invocations USING btree (status, closes_at, created_at) WHERE ((status)::text = 'pending'::text);

CREATE INDEX idx_batch_step_invocations_scope ON batch_step_invocations USING btree (run_id, workflow_step_attempt_id, status);

CREATE INDEX idx_batch_step_members_item ON batch_step_members USING btree (run_id, workflow_step_attempt_id, item_id);

CREATE INDEX idx_connection_action_requirements_connection ON connection_action_requirements USING btree (connection_id, status);

CREATE INDEX idx_connection_action_requirements_resolution ON connection_action_requirements USING btree (tenant_id, project_id, environment_name, alias, external_user_id, status);

CREATE INDEX idx_connection_audit_tenant_created ON connection_audit_events USING btree (tenant_id, created_at DESC);

CREATE INDEX idx_connection_auth_attempts_expiry ON connection_authorization_attempts USING btree (expires_at) WHERE (status = 'pending'::text);

CREATE INDEX idx_connection_grants_expiry ON connection_capability_grants USING btree (expires_at) WHERE (revoked_at IS NULL);

CREATE INDEX idx_connections_expiry ON connections USING btree (expires_at) WHERE ((status = 'ready'::text) AND (expires_at IS NOT NULL));

CREATE INDEX idx_connections_tenant_principal ON connections USING btree (tenant_id, principal_kind, status);

CREATE INDEX idx_deployment_artifacts_project_commit ON deployment_artifacts USING btree (project_id, commit_sha);

CREATE INDEX idx_deployment_runtimes_ready ON deployment_runtimes USING btree (artifact_id, binding_id, status, replica_index);

CREATE INDEX idx_execution_allocations_project_environment ON execution_allocations USING btree (project_id, environment_name, status);

CREATE INDEX idx_execution_allocations_tenant_status ON execution_allocations USING btree (tenant_id, status);

CREATE INDEX idx_execution_jobs_claim ON execution_jobs USING btree (status, available_at, priority DESC, created_at) WHERE ((status)::text = 'pending'::text);

CREATE INDEX idx_execution_jobs_pending_rank ON execution_jobs USING btree (tenant_id, priority DESC, created_at, id) WHERE ((status)::text = 'pending'::text);

CREATE INDEX idx_execution_jobs_running_by_tenant ON execution_jobs USING btree (tenant_id) WHERE ((status)::text = 'running'::text);

CREATE INDEX idx_execution_jobs_step_attempt ON execution_jobs USING btree (workflow_run_id, workflow_step_attempt_id, status) WHERE (workflow_step_attempt_id IS NOT NULL);

CREATE INDEX idx_execution_jobs_unhandled_exhaustion ON execution_jobs USING btree (completed_at, id) WHERE (((status)::text = 'failed'::text) AND (NOT exhaustion_handled));

CREATE INDEX idx_execution_jobs_workflow_run ON execution_jobs USING btree (workflow_run_id, status);

CREATE INDEX idx_notification_delivery_claim ON notification_deliveries USING btree (status, next_attempt_at, lease_expires_at);

CREATE INDEX idx_project_event_monitors_claim ON project_event_monitors USING btree (status, placement, next_poll_at, lease_expires_at);

CREATE INDEX idx_project_events_kind ON project_events USING btree (project_id, kind, sequence);

CREATE INDEX idx_project_events_replay ON project_events USING btree (project_id, sequence);

CREATE INDEX idx_project_plugins_project ON project_plugins USING btree (project_id);

CREATE INDEX idx_project_secrets_project ON project_secrets USING btree (project_id);

CREATE INDEX idx_projects_tenant_id ON projects USING btree (tenant_id);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions USING btree (tenant_id, external_user_id) WHERE (retired_at IS NULL);

CREATE INDEX idx_rate_reservation_buckets_blocked ON rate_reservation_buckets USING btree (blocked_until) WHERE (blocked_until IS NOT NULL);

CREATE INDEX idx_sandboxes_project ON project_sandboxes USING btree (project_id, sandbox_type);

CREATE INDEX idx_schedule_bindings_due ON schedule_bindings USING btree (next_fire_at);

CREATE INDEX idx_schedule_occurrence_claim ON schedule_occurrences USING btree (status, next_attempt_at, lease_expires_at);

CREATE INDEX idx_session_mailbox_destination ON session_mailbox_items USING btree (destination_host_id, status, created_at);

CREATE INDEX idx_session_sync_claim ON session_sync_intents USING btree (status, next_attempt_at, lease_expires_at);

CREATE INDEX idx_stock_project_access_requests_project_status ON stock_project_access_requests USING btree (project_id, status, requested_at DESC);

CREATE INDEX idx_stock_project_invitations_project ON stock_project_invitations USING btree (project_id, created_at DESC);

CREATE INDEX idx_trigger_bindings_environment ON trigger_bindings USING btree (project_id, environment_name) WHERE (environment_name IS NOT NULL);

CREATE INDEX idx_trigger_bindings_kind ON trigger_bindings USING btree (project_id, commit_sha, trigger_kind);

CREATE INDEX idx_user_notification_session ON user_notification_events USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL);

CREATE INDEX idx_watchers_dispatch ON watchers USING btree (status, project_id, cursor_sequence);

CREATE INDEX idx_watchers_session ON watchers USING btree (session_id, created_at);

CREATE INDEX idx_workflow_pauses_due ON workflow_pauses USING btree (timeout_at, id) WHERE (((status)::text = 'open'::text) AND (timeout_at IS NOT NULL));

CREATE INDEX idx_workflow_pauses_run ON workflow_pauses USING btree (run_id, status);

CREATE INDEX idx_workflow_run_events_run_sequence ON workflow_run_events USING btree (run_id, created_at, sequence);

CREATE INDEX idx_workflow_run_steps_run ON workflow_run_steps USING btree (run_id, started_at, id);

CREATE INDEX idx_workflow_runs_active_by_project ON workflow_runs USING btree (project_id) WHERE ((parent_run_id IS NULL) AND ((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])));

CREATE INDEX idx_workflow_runs_allocation ON workflow_runs USING btree (allocation_id) WHERE (allocation_id IS NOT NULL);

CREATE INDEX idx_workflow_runs_correlation_history ON workflow_runs USING btree (project_id, workflow_name, correlation_key, created_at DESC) WHERE (correlation_key IS NOT NULL);

CREATE INDEX idx_workflow_runs_deployment_artifact ON workflow_runs USING btree (deployment_artifact_id) WHERE (deployment_artifact_id IS NOT NULL);

CREATE INDEX idx_workflow_runs_live_children ON workflow_runs USING btree (parent_run_id) WHERE ((parent_run_id IS NOT NULL) AND ((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])));

CREATE INDEX idx_workflow_runs_parent ON workflow_runs USING btree (parent_run_id, created_at) WHERE (parent_run_id IS NOT NULL);

CREATE INDEX idx_workflow_runs_project ON workflow_runs USING btree (project_id, workflow_name, created_at DESC);

CREATE INDEX idx_workflow_runs_retention ON workflow_runs USING btree (project_id, completed_at) WHERE (((status)::text = ANY ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])) AND (completed_at IS NOT NULL));

CREATE INDEX idx_workflow_runs_status ON workflow_runs USING btree (project_id, status, created_at DESC);

CREATE INDEX idx_workflow_step_attempts_rate_blocked ON workflow_step_attempts USING btree (rate_blocked_until) WHERE (rate_blocked_until IS NOT NULL);

CREATE INDEX idx_workflow_step_attempts_run ON workflow_step_attempts USING btree (run_id, step_index, attempt);

CREATE INDEX store_documents_prefix_idx ON store_documents USING btree (project_id, path text_pattern_ops);

CREATE INDEX store_documents_search_idx ON store_documents USING gin (search_vector);

CREATE UNIQUE INDEX uq_agent_message_delivery_idempotency ON agent_messages USING btree (session_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE UNIQUE INDEX uq_agent_turns_running_session ON agent_turns USING btree (session_id) WHERE ((status)::text = 'running'::text);

CREATE UNIQUE INDEX uq_app_active_version ON app_versions USING btree (app_id) WHERE is_active;

CREATE UNIQUE INDEX uq_connection_action_requirements_pending_job ON connection_action_requirements USING btree (execution_job_id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX uq_execution_allocations_active_workload ON execution_allocations USING btree (workload_kind, root_workload_id) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX uq_execution_job_dedupe ON execution_jobs USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);

CREATE UNIQUE INDEX uq_session_mailbox_idempotency ON session_mailbox_items USING btree (session_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE UNIQUE INDEX uq_session_mailbox_message ON session_mailbox_items USING btree (session_id, message_id);

CREATE UNIQUE INDEX uq_stock_project_access_requests_pending ON stock_project_access_requests USING btree (project_id, external_user_id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX uq_workflow_pauses_open_signal ON workflow_pauses USING btree (run_id, signal_name) WHERE ((signal_name IS NOT NULL) AND ((status)::text = 'open'::text));

CREATE UNIQUE INDEX uq_workflow_runs_correlation_active ON workflow_runs USING btree (project_id, workflow_name, correlation_key) WHERE ((correlation_key IS NOT NULL) AND ((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'canceled'::character varying])::text[])));

CREATE UNIQUE INDEX uq_workflow_runs_parent_step_child ON workflow_runs USING btree (parent_run_id, parent_workflow_step_attempt_id) WHERE ((parent_run_id IS NOT NULL) AND (parent_workflow_step_attempt_id IS NOT NULL));

ALTER TABLE ONLY active_run_invocations
    ADD CONSTRAINT active_run_invocations_execution_job_id_fkey FOREIGN KEY (execution_job_id) REFERENCES execution_jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY active_run_invocations
    ADD CONSTRAINT active_run_invocations_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_messages
    ADD CONSTRAINT agent_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_runtime_events
    ADD CONSTRAINT agent_runtime_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_runtime_requests
    ADD CONSTRAINT agent_runtime_requests_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_sessions
    ADD CONSTRAINT agent_sessions_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES execution_allocations(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_sessions
    ADD CONSTRAINT agent_sessions_parent_session_id_fkey FOREIGN KEY (parent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_sessions
    ADD CONSTRAINT agent_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_sessions
    ADD CONSTRAINT agent_sessions_sandbox_id_fkey FOREIGN KEY (sandbox_id) REFERENCES project_sandboxes(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_turns
    ADD CONSTRAINT agent_turns_message_id_fkey FOREIGN KEY (message_id) REFERENCES agent_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_turns
    ADD CONSTRAINT agent_turns_result_message_id_fkey FOREIGN KEY (result_message_id) REFERENCES agent_messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_turns
    ADD CONSTRAINT agent_turns_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY app_storage
    ADD CONSTRAINT app_storage_app_id_fkey FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE;

ALTER TABLE ONLY app_versions
    ADD CONSTRAINT app_versions_app_id_fkey FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE;

ALTER TABLE ONLY apps
    ADD CONSTRAINT apps_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES execution_allocations(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_execution_job_id_fkey FOREIGN KEY (execution_job_id) REFERENCES execution_jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_action_requirements
    ADD CONSTRAINT connection_action_requirements_workflow_step_attempt_id_fkey FOREIGN KEY (workflow_step_attempt_id) REFERENCES workflow_step_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_audit_events
    ADD CONSTRAINT connection_audit_events_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES execution_allocations(id) ON DELETE SET NULL;

ALTER TABLE ONLY connection_audit_events
    ADD CONSTRAINT connection_audit_events_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE SET NULL;

ALTER TABLE ONLY connection_audit_events
    ADD CONSTRAINT connection_audit_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY connection_audit_events
    ADD CONSTRAINT connection_audit_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_authorization_attempts
    ADD CONSTRAINT connection_authorization_attempt_reauthorize_connection_id_fkey FOREIGN KEY (reauthorize_connection_id) REFERENCES connections(id) ON DELETE SET NULL;

ALTER TABLE ONLY connection_authorization_attempts
    ADD CONSTRAINT connection_authorization_attempts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_authorization_attempts
    ADD CONSTRAINT connection_authorization_attempts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_agent_session_id_fkey FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES execution_allocations(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES environment_connection_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_capability_grants
    ADD CONSTRAINT connection_capability_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY deployment_artifacts
    ADD CONSTRAINT deployment_artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY deployment_runtimes
    ADD CONSTRAINT deployment_runtimes_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES deployment_artifacts(id) ON DELETE CASCADE;

ALTER TABLE ONLY environment_connection_bindings
    ADD CONSTRAINT environment_connection_bindings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY environment_connection_bindings
    ADD CONSTRAINT environment_connection_bindings_service_connection_id_fkey FOREIGN KEY (service_connection_id) REFERENCES connections(id) ON DELETE SET NULL;

ALTER TABLE ONLY environment_connection_bindings
    ADD CONSTRAINT environment_connection_bindings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY execution_allocations
    ADD CONSTRAINT execution_allocations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY execution_allocations
    ADD CONSTRAINT execution_allocations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY execution_jobs
    ADD CONSTRAINT execution_jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY execution_jobs
    ADD CONSTRAINT execution_jobs_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY active_run_invocations
    ADD CONSTRAINT fk_active_run_invocation_step_attempt FOREIGN KEY (workflow_run_id, workflow_step_attempt_id) REFERENCES workflow_step_attempts(run_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_execution_states
    ADD CONSTRAINT fk_batch_execution_step_attempt FOREIGN KEY (run_id, workflow_step_attempt_id) REFERENCES workflow_step_attempts(run_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_items
    ADD CONSTRAINT fk_batch_item_execution FOREIGN KEY (run_id, workflow_step_attempt_id) REFERENCES batch_execution_states(run_id, workflow_step_attempt_id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_item_steps
    ADD CONSTRAINT fk_batch_item_step_item FOREIGN KEY (run_id, workflow_step_attempt_id, item_id) REFERENCES batch_items(run_id, workflow_step_attempt_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_sink_chunks
    ADD CONSTRAINT fk_batch_sink_chunk_execution FOREIGN KEY (run_id, workflow_step_attempt_id) REFERENCES batch_execution_states(run_id, workflow_step_attempt_id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_step_invocations
    ADD CONSTRAINT fk_batch_step_invocation_execution FOREIGN KEY (run_id, workflow_step_attempt_id) REFERENCES batch_execution_states(run_id, workflow_step_attempt_id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_step_members
    ADD CONSTRAINT fk_batch_step_member_invocation FOREIGN KEY (run_id, workflow_step_attempt_id, invocation_id) REFERENCES batch_step_invocations(run_id, workflow_step_attempt_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY batch_step_members
    ADD CONSTRAINT fk_batch_step_member_item FOREIGN KEY (run_id, workflow_step_attempt_id, item_id) REFERENCES batch_items(run_id, workflow_step_attempt_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY execution_jobs
    ADD CONSTRAINT fk_execution_job_step_attempt FOREIGN KEY (workflow_run_id, workflow_step_attempt_id) REFERENCES workflow_step_attempts(run_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY trigger_bindings
    ADD CONSTRAINT fk_trigger_binding_scan FOREIGN KEY (project_id, commit_sha) REFERENCES trigger_binding_scans(project_id, commit_sha) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_pauses
    ADD CONSTRAINT fk_workflow_pause_step_attempt FOREIGN KEY (run_id, workflow_step_attempt_id) REFERENCES workflow_step_attempts(run_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_run_states
    ADD CONSTRAINT fk_workflow_run_states_active_step_attempt FOREIGN KEY (run_id, active_workflow_step_attempt_id) REFERENCES workflow_step_attempts(run_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT fk_workflow_runs_parent_run FOREIGN KEY (parent_run_id, project_id) REFERENCES workflow_runs(id, project_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT fk_workflow_runs_parent_step_attempt FOREIGN KEY (parent_run_id, parent_workflow_step_attempt_id) REFERENCES workflow_step_attempts(run_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY member_connection_attachments
    ADD CONSTRAINT member_connection_attachments_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY member_connection_attachments
    ADD CONSTRAINT member_connection_attachments_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY member_connection_attachments
    ADD CONSTRAINT member_connection_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY notification_deliveries
    ADD CONSTRAINT notification_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES user_notification_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY notification_deliveries
    ADD CONSTRAINT notification_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_event_monitors
    ADD CONSTRAINT project_event_monitors_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_events
    ADD CONSTRAINT project_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_plugins
    ADD CONSTRAINT project_plugins_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_sandboxes
    ADD CONSTRAINT project_sandboxes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_secrets
    ADD CONSTRAINT project_secrets_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY publications
    ADD CONSTRAINT publications_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY push_subscriptions
    ADD CONSTRAINT push_subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY rate_reservation_buckets
    ADD CONSTRAINT rate_reservation_buckets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY schedule_bindings
    ADD CONSTRAINT schedule_bindings_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES trigger_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY schedule_occurrences
    ADD CONSTRAINT schedule_occurrences_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES schedule_bindings(binding_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_mailbox_items
    ADD CONSTRAINT session_mailbox_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_mailbox_items
    ADD CONSTRAINT session_mailbox_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_sync_intents
    ADD CONSTRAINT session_sync_intents_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_sync_intents
    ADD CONSTRAINT session_sync_intents_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY stock_project_access_requests
    ADD CONSTRAINT stock_project_access_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY stock_project_admission_policies
    ADD CONSTRAINT stock_project_admission_policies_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY stock_project_invitations
    ADD CONSTRAINT stock_project_invitations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY store_document_versions
    ADD CONSTRAINT store_document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES store_documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY store_documents
    ADD CONSTRAINT store_documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_app_policies
    ADD CONSTRAINT tenant_app_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_execution_policies
    ADD CONSTRAINT tenant_execution_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY trigger_binding_scans
    ADD CONSTRAINT trigger_binding_scans_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_notification_events
    ADD CONSTRAINT user_notification_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_notification_events
    ADD CONSTRAINT user_notification_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_notification_events
    ADD CONSTRAINT user_notification_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY watcher_runs
    ADD CONSTRAINT watcher_runs_event_id_fkey FOREIGN KEY (event_id) REFERENCES project_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY watcher_runs
    ADD CONSTRAINT watcher_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY watcher_runs
    ADD CONSTRAINT watcher_runs_watcher_id_fkey FOREIGN KEY (watcher_id) REFERENCES watchers(id) ON DELETE CASCADE;

ALTER TABLE ONLY watchers
    ADD CONSTRAINT watchers_deployment_artifact_id_fkey FOREIGN KEY (deployment_artifact_id) REFERENCES deployment_artifacts(id);

ALTER TABLE ONLY watchers
    ADD CONSTRAINT watchers_monitor_id_fkey FOREIGN KEY (monitor_id) REFERENCES project_event_monitors(id) ON DELETE SET NULL;

ALTER TABLE ONLY watchers
    ADD CONSTRAINT watchers_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY watchers
    ADD CONSTRAINT watchers_session_id_fkey FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_run_events
    ADD CONSTRAINT workflow_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_run_states
    ADD CONSTRAINT workflow_run_states_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES execution_allocations(id) ON DELETE SET NULL;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_deployment_artifact_id_fkey FOREIGN KEY (deployment_artifact_id) REFERENCES deployment_artifacts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY workflow_runs
    ADD CONSTRAINT workflow_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY workflow_step_attempts
    ADD CONSTRAINT workflow_step_attempts_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE;
