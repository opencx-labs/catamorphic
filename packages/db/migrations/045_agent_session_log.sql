-- Agent sessions are an event log of turns (ADR 0196); runners run
-- harnesses beside their workspace (ADR 0197).
--
-- Existing chats are converted in place: messages become items, the old
-- queue rows become turns, a session's provider anchor becomes its provider
-- thread. Converted sessions start their log at sequence 0; their history
-- is the projection the log continues from.

SELECT set_config('catamorphic.suppress_session_events', 'true', true);

-- ---------------------------------------------------------------------------
-- The log and its receipts

ALTER TABLE agent_sessions ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0;

CREATE TABLE agent_session_events (
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence > 0),
    type text NOT NULL,
    payload jsonb NOT NULL,
    command_id text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, sequence)
);

CREATE TABLE agent_session_commands (
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    command_id text NOT NULL,
    type text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
    sequence bigint NOT NULL,
    result jsonb,
    error jsonb,
    external_user_id character varying(255),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, command_id)
);

-- ---------------------------------------------------------------------------
-- Provider threads and their portable native state

CREATE TABLE agent_provider_threads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    harness text NOT NULL,
    native_ref jsonb,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'unavailable', 'closed')),
    last_turn_ordinal integer,
    portable boolean NOT NULL DEFAULT false,
    -- Where a file-backed native state lives in the harness home (Codex rollouts).
    state_path text,
    -- A forked session's first thread: the source thread and the turn it forks through.
    fork_source jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX agent_provider_threads_session
    ON agent_provider_threads (session_id, updated_at DESC);

CREATE TABLE agent_provider_thread_entries (
    thread_id uuid NOT NULL REFERENCES agent_provider_threads(id) ON DELETE CASCADE,
    subpath text NOT NULL DEFAULT '',
    seq bigint NOT NULL,
    entry_uuid text,
    entry jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, subpath, seq)
);

CREATE UNIQUE INDEX agent_provider_thread_entries_uuid
    ON agent_provider_thread_entries (thread_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;

INSERT INTO agent_provider_threads (session_id, harness, native_ref, status, portable)
SELECT id, provider,
       jsonb_build_object('id', provider_session_id, 'strength', 'strong'),
       'active', false
  FROM agent_sessions
 WHERE provider_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Items: the ordered transcript

CREATE TABLE agent_items (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    turn_id uuid,
    attempt_id uuid,
    parent_item_id uuid,
    position bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN (
        'user_message', 'assistant_message', 'reasoning', 'tool_call', 'command',
        'file_change', 'plan', 'request', 'subagent', 'notice', 'context_handoff')),
    status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'cancelled')),
    -- Message text, command, or summary: what search and workflow events read.
    text text NOT NULL DEFAULT '',
    author_kind character varying(20),
    author_payload jsonb,
    dispatch text,
    attention boolean NOT NULL DEFAULT false,
    idempotency_key character varying(500),
    -- The whole protocol item (`@catamorphic/agent-protocol` Item).
    payload jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX agent_items_session_position ON agent_items (session_id, position);
CREATE INDEX agent_items_turn ON agent_items (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX agent_items_attention ON agent_items (session_id, created_at DESC) WHERE attention;
CREATE UNIQUE INDEX agent_items_idempotency
    ON agent_items (session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Messages, in transcript order. A step log becomes items before its reply.
DO $$
DECLARE
  message record;
  step record;
  pos bigint := 0;
  last_session uuid := NULL;
  kind_name text;
  step_kind text;
  is_marker boolean;
  item_status text;
  meta jsonb;
  reply_text text;
BEGIN
  FOR message IN SELECT * FROM agent_messages ORDER BY session_id, seq LOOP
    IF last_session IS DISTINCT FROM message.session_id THEN
      pos := 0;
      last_session := message.session_id;
    END IF;
    meta := COALESCE(message.metadata, '{}'::jsonb);
    IF message.role = 'assistant' THEN
      FOR step IN
        SELECT value AS event, ordinality
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(meta->'events') = 'array' THEN meta->'events' ELSE '[]'::jsonb END)
          WITH ORDINALITY
      LOOP
        step_kind := step.event->>'type';
        IF step_kind NOT IN ('tool_call', 'command', 'file_edit', 'subagent') THEN CONTINUE; END IF;
        pos := pos + 1;
        INSERT INTO agent_items (id, session_id, position, kind, status, text, payload, created_at, updated_at)
        VALUES (
          gen_random_uuid(), message.session_id, pos,
          CASE step_kind WHEN 'file_edit' THEN 'file_change' ELSE step_kind END,
          'completed',
          COALESCE(step.event->>'description', step.event->>'content', step.event->>'toolName', ''),
          CASE step_kind
            WHEN 'command' THEN jsonb_build_object('kind', 'command',
              'command', COALESCE(step.event->>'content', ''),
              'description', step.event->'description', 'output', '', 'exitCode', NULL)
            WHEN 'file_edit' THEN jsonb_build_object('kind', 'file_change',
              'path', COALESCE(step.event->>'filePath', ''), 'change', 'modified', 'previousPath', NULL)
            WHEN 'subagent' THEN jsonb_build_object('kind', 'subagent',
              'title', COALESCE(step.event->>'content', step.event->>'subagentType', 'Subagent'),
              'agentType', step.event->'subagentType', 'childSessionId', NULL, 'result', NULL)
            ELSE jsonb_build_object('kind', 'tool_call',
              'tool', COALESCE(step.event->>'toolName', 'tool'), 'server', NULL,
              'description', step.event->'description',
              'input', COALESCE(step.event->'toolInput', 'null'::jsonb),
              'result', COALESCE(step.event->'toolResult', 'null'::jsonb), 'error', NULL)
          END,
          message.created_at, message.created_at);
      END LOOP;
      pos := pos + 1;
      item_status := CASE meta->>'status'
        WHEN 'failed' THEN 'failed'
        WHEN 'in_progress' THEN 'failed'
        ELSE 'completed' END;
      reply_text := CASE WHEN meta->>'status' = 'in_progress'
        THEN COALESCE(meta->>'partialContent', '')
        ELSE COALESCE(NULLIF(meta->>'partialContent', ''), message.content) END;
      INSERT INTO agent_items (id, session_id, position, kind, status, text, author_kind, author_payload, payload, created_at, updated_at)
      VALUES (message.id, message.session_id, pos, 'assistant_message', item_status,
        reply_text, 'agent', message.author_payload,
        jsonb_build_object('kind', 'assistant_message', 'text', reply_text,
          'agentId', message.author_payload->'agentId'),
        message.created_at, message.created_at);
    ELSE
      pos := pos + 1;
      is_marker := message.role = 'system' AND meta ? 'marker';
      kind_name := CASE WHEN is_marker THEN 'notice' ELSE 'user_message' END;
      INSERT INTO agent_items (id, session_id, position, kind, status, text, author_kind, author_payload,
                               dispatch, attention, idempotency_key, payload, created_at, updated_at)
      VALUES (message.id, message.session_id, pos, kind_name, 'completed', message.content,
        message.author_kind, message.author_payload,
        CASE message.delivery_mode WHEN 'next_turn' THEN 'queue' ELSE message.delivery_mode END,
        COALESCE(meta->>'attention' = 'required', false), message.idempotency_key,
        CASE WHEN is_marker THEN jsonb_build_object('kind', 'notice',
               'code', meta->>'marker', 'text', message.content, 'data', meta)
             ELSE jsonb_build_object('kind', 'user_message',
               'author', message.author_payload || jsonb_build_object('kind', message.author_kind),
               'text', message.content,
               'attachments', CASE WHEN jsonb_typeof(meta->'attachments') = 'array' THEN meta->'attachments' ELSE '[]'::jsonb END,
               'dispatch', CASE message.delivery_mode WHEN 'next_turn' THEN 'queue' ELSE message.delivery_mode END,
               'attention', CASE WHEN meta->>'attention' = 'required' THEN to_jsonb('required'::text) ELSE 'null'::jsonb END,
               'idempotencyKey', to_jsonb(message.idempotency_key),
               'metadata', meta - 'attachments' - 'attention' - 'status' - 'events')
        END,
        message.created_at, message.created_at);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Turns, attempts, and the commands a running attempt has not yet taken

ALTER TABLE agent_turns RENAME TO agent_turns_legacy;
ALTER INDEX agent_turns_pkey RENAME TO agent_turns_legacy_pkey;
DROP INDEX IF EXISTS uq_agent_turns_running_session;
DROP INDEX IF EXISTS idx_agent_turns_claim;
DROP INDEX IF EXISTS idx_agent_turns_session;
DROP INDEX IF EXISTS agent_turns_running_lease_owner;
DROP TRIGGER IF EXISTS session_turn_events ON agent_turns_legacy;
DROP TRIGGER IF EXISTS session_message_events ON agent_messages;

CREATE TABLE agent_turns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'held', 'preparing', 'running', 'waiting', 'finalizing',
        'completed', 'failed', 'interrupted', 'cancelled', 'rolled_back')),
    input_item_id uuid REFERENCES agent_items(id) ON DELETE SET NULL,
    dispatch text NOT NULL DEFAULT 'queue' CHECK (dispatch IN ('queue', 'interrupt')),
    priority integer NOT NULL DEFAULT 0,
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    lease_owner character varying(255),
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    cancellation_requested_at timestamp with time zone,
    activity text,
    activity_at timestamp with time zone,
    attempt_count integer NOT NULL DEFAULT 0,
    active_attempt_id uuid,
    provider_thread_id uuid REFERENCES agent_provider_threads(id) ON DELETE SET NULL,
    error jsonb,
    outcome jsonb,
    checkpoint_before character(40),
    checkpoint_after character(40),
    continuation_of uuid,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (session_id, ordinal)
);

CREATE INDEX agent_turns_claim ON agent_turns (session_id, status, priority DESC, created_at)
    WHERE status IN ('queued', 'preparing', 'running', 'waiting', 'finalizing');
CREATE INDEX agent_turns_lease_owner ON agent_turns (lease_owner)
    WHERE status IN ('preparing', 'running', 'waiting', 'finalizing');
-- One turn works in a session at a time.
CREATE UNIQUE INDEX agent_turns_one_active ON agent_turns (session_id)
    WHERE status IN ('preparing', 'running', 'waiting', 'finalizing');
CREATE UNIQUE INDEX agent_turns_continuation ON agent_turns (continuation_of)
    WHERE continuation_of IS NOT NULL;

INSERT INTO agent_turns (id, session_id, ordinal, status, input_item_id, dispatch, priority,
                         available_at, error, outcome, checkpoint_after, created_at, started_at,
                         completed_at, updated_at, attempt_count)
SELECT legacy.id, legacy.session_id,
       row_number() OVER (PARTITION BY legacy.session_id ORDER BY legacy.created_at, legacy.id),
       CASE legacy.status
         WHEN 'running' THEN 'interrupted'
         WHEN 'completed' THEN 'completed'
         WHEN 'failed' THEN CASE WHEN result.metadata->>'interrupted' = 'true' THEN 'interrupted' ELSE 'failed' END
         ELSE legacy.status END,
       legacy.message_id,
       CASE legacy.delivery_mode WHEN 'interrupt' THEN 'interrupt' ELSE 'queue' END,
       legacy.priority, legacy.available_at,
       CASE WHEN legacy.status IN ('failed', 'running') THEN jsonb_strip_nulls(jsonb_build_object(
         'message', CASE WHEN legacy.status = 'running'
           THEN 'This turn stopped before it finished, when Work was updated.'
           ELSE COALESCE(legacy.error, result.content, 'The turn stopped') END,
         'kind', result.metadata->'errorKind')) END,
       jsonb_strip_nulls(jsonb_build_object(
         'changedFiles', CASE WHEN jsonb_typeof(result.metadata->'changedFiles') = 'array' THEN result.metadata->'changedFiles' ELSE '[]'::jsonb END,
         'usage', result.metadata->'usage',
         'storeSync', result.metadata->'storeSync',
         'workspaceSync', result.metadata->'workspaceSync')),
       result.commit_sha,
       legacy.created_at, legacy.started_at, COALESCE(legacy.completed_at, legacy.updated_at),
       legacy.updated_at, GREATEST(legacy.attempt, 1)
  FROM agent_turns_legacy legacy
  LEFT JOIN agent_messages result ON result.id = legacy.result_message_id;

-- Each converted item belongs to the latest turn whose input came before it.
UPDATE agent_items item SET turn_id = (
    SELECT turn.id FROM agent_turns turn
      JOIN agent_items input ON input.id = turn.input_item_id
     WHERE turn.session_id = item.session_id AND input.position <= item.position
     ORDER BY input.position DESC LIMIT 1)
 WHERE item.kind <> 'notice';

UPDATE agent_items SET payload = payload || jsonb_build_object(
    'id', id, 'sessionId', session_id, 'turnId', turn_id, 'attemptId', NULL,
    'parentItemId', NULL, 'position', position, 'status', status, 'nativeRef', NULL,
    'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'startedAt', NULL, 'endedAt', NULL);

UPDATE agent_turns turn SET provider_thread_id = thread.id
  FROM agent_provider_threads thread WHERE thread.session_id = turn.session_id;

CREATE TABLE agent_turn_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id uuid NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    reason text NOT NULL CHECK (reason IN ('initial', 'retry', 'steer_restart', 'recovery')),
    status text NOT NULL CHECK (status IN (
        'preparing', 'running', 'completed', 'failed', 'interrupted', 'lost', 'superseded')),
    provider_thread_id uuid REFERENCES agent_provider_threads(id) ON DELETE SET NULL,
    native_turn_ref jsonb,
    -- Where the runner is and how far its output was read (never streamed).
    runner jsonb,
    -- Set once the harness was asked to start: after it, the attempt is bound to its runner.
    provider_started_at timestamp with time zone,
    error jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    UNIQUE (turn_id, ordinal)
);

CREATE TABLE agent_turn_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id uuid NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
    attempt_id uuid REFERENCES agent_turn_attempts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('steer', 'interrupt', 'respond', 'release', 'stop')),
    payload jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'acknowledged', 'dropped')),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    sent_at timestamp with time zone,
    acknowledged_at timestamp with time zone
);

CREATE INDEX agent_turn_commands_open ON agent_turn_commands (turn_id, created_at)
    WHERE status IN ('pending', 'sent');

-- ---------------------------------------------------------------------------
-- Runtime requests belong to the attempt that asked

ALTER TABLE agent_runtime_requests ADD COLUMN item_id uuid;
ALTER TABLE agent_runtime_requests ADD COLUMN attempt_id uuid;
ALTER TABLE agent_runtime_requests ADD COLUMN answerable boolean NOT NULL DEFAULT true;
ALTER TABLE agent_runtime_requests ADD COLUMN blocking boolean NOT NULL DEFAULT true;
ALTER TABLE agent_runtime_requests ADD COLUMN reason text;

UPDATE agent_runtime_requests
   SET status = 'expired', answerable = false,
       reason = 'The agent that asked stopped before it was answered.',
       resolved_at = now(), updated_at = now()
 WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- References to messages now name items

ALTER TABLE agent_delegations ADD COLUMN result_item_id uuid REFERENCES agent_items(id) ON DELETE SET NULL;
UPDATE agent_delegations SET result_item_id = result_message_id;
ALTER TABLE agent_delegations DROP COLUMN result_message_id;

ALTER TABLE session_mailbox_items DROP CONSTRAINT chk_session_mailbox_delivery_mode;
UPDATE session_mailbox_items SET delivery_mode = 'queue' WHERE delivery_mode = 'next_turn';
ALTER TABLE session_mailbox_items ADD CONSTRAINT chk_session_mailbox_delivery_mode
    CHECK (delivery_mode IN ('message_only', 'queue', 'steer', 'interrupt'));
ALTER TABLE session_mailbox_items RENAME COLUMN message_id TO item_id;

-- Mirrors replicate the log (ADR 0196): watermarks are sequences.
ALTER TABLE session_sync_intents RENAME COLUMN desired_message_count TO desired_sequence;
ALTER TABLE session_sync_intents RENAME COLUMN acknowledged_message_count TO acknowledged_sequence;
ALTER TABLE session_sync_intents ALTER COLUMN desired_sequence TYPE bigint;
ALTER TABLE session_sync_intents ALTER COLUMN acknowledged_sequence TYPE bigint;
UPDATE session_sync_intents SET desired_sequence = 0, acknowledged_sequence = NULL, status = 'pending'
 WHERE status <> 'diverged';

DROP INDEX IF EXISTS idx_agent_sessions_resumable;
ALTER TABLE agent_sessions RENAME COLUMN mirror_message_count TO mirror_sequence;
ALTER TABLE agent_sessions ALTER COLUMN mirror_sequence TYPE bigint;
CREATE INDEX idx_agent_sessions_resumable ON agent_sessions (authority_host_id, authority_seen_at)
    WHERE status = 'active' AND mirror_sequence > 0;

-- The anchor lives on provider threads.
ALTER TABLE agent_sessions DROP COLUMN provider;
ALTER TABLE agent_sessions DROP COLUMN provider_session_id;

DROP TABLE agent_turns_legacy;
DROP TABLE agent_messages;
DROP TABLE agent_runtime_events;

-- ---------------------------------------------------------------------------
-- Workflow-facing session events (ADR 0090, 0181), from items and turns

CREATE OR REPLACE FUNCTION publish_session_event() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  session_row agent_sessions%ROWTYPE;
  event_kind text;
  detail jsonb := '{}';
  actor jsonb;
  causation jsonb := '[]';
  input_row agent_items%ROWTYPE;
BEGIN
  IF current_setting('catamorphic.suppress_session_events', true) = 'true' THEN RETURN NEW; END IF;
  actor := NULLIF(current_setting('catamorphic.session_actor', true), '')::jsonb;
  causation := COALESCE(actor->'causation', '[]');
  IF TG_TABLE_NAME = 'agent_sessions' THEN
    session_row := NEW;
    IF TG_OP = 'INSERT' THEN event_kind := 'session.created';
    ELSIF NEW.state_revision = OLD.state_revision THEN RETURN NEW;
    ELSIF NEW.work_status IS DISTINCT FROM OLD.work_status THEN event_kind := 'session.work-changed';
    ELSIF NEW.authority_revision IS DISTINCT FROM OLD.authority_revision THEN event_kind := 'session.authority-changed';
    ELSE event_kind := 'session.state-changed'; END IF;
    IF TG_OP = 'UPDATE' THEN detail := jsonb_build_object('previousStatus', OLD.status, 'previousWorkStatus', OLD.work_status); END IF;
  ELSE
    SELECT * INTO session_row FROM agent_sessions WHERE id = NEW.session_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'agent_items' THEN
      IF NEW.kind = 'assistant_message' THEN
        -- Emit once, when a streamed reply settles; copied history arrives settled.
        IF TG_OP = 'INSERT' OR OLD.status <> 'in_progress' OR NEW.status = 'in_progress' THEN RETURN NEW; END IF;
        event_kind := 'session.message-sent';
        SELECT input.* INTO input_row FROM agent_turns turn JOIN agent_items input ON input.id = turn.input_item_id
         WHERE turn.id = NEW.turn_id;
        causation := COALESCE(input_row.payload->'metadata'->'causation', '[]');
        actor := COALESCE(NEW.author_payload, '{}'::jsonb) || jsonb_build_object('kind', 'agent');
        detail := jsonb_build_object('messageId', NEW.id, 'content', NEW.text, 'deliveryMode', 'message_only',
          'status', NEW.status, 'turnId', NEW.turn_id);
      ELSIF NEW.kind = 'user_message' THEN
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        event_kind := 'session.message-received';
        causation := COALESCE(NEW.payload->'metadata'->'causation', '[]');
        actor := COALESCE(NEW.author_payload, '{}'::jsonb) || jsonb_build_object('kind', NEW.author_kind);
        detail := jsonb_build_object('messageId', NEW.id, 'content', NEW.text, 'deliveryMode', NEW.dispatch,
          'status', NEW.status);
      ELSE
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'agent_session_views' THEN
      IF TG_OP = 'UPDATE' AND NEW.visibility = OLD.visibility THEN RETURN NEW; END IF;
      IF NEW.visibility <> 'archived' AND (TG_OP = 'INSERT' OR OLD.visibility <> 'archived') THEN RETURN NEW; END IF;
      event_kind := 'session.state-changed';
      detail := jsonb_build_object('visibility', NEW.visibility);
    ELSE
      IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NEW; END IF;
      event_kind := 'session.turn-changed';
      detail := jsonb_build_object('turnId', NEW.id, 'messageId', NEW.input_item_id, 'status', NEW.status,
        'resultMessageId', (SELECT id FROM agent_items WHERE turn_id = NEW.id AND kind = 'assistant_message'
                              ORDER BY position DESC LIMIT 1));
      SELECT author_payload || jsonb_build_object('kind', author_kind), COALESCE(payload->'metadata'->'causation', '[]')
        INTO actor, causation FROM agent_items WHERE id = NEW.input_item_id;
    END IF;
  END IF;
  IF actor IS NULL THEN
    SELECT command.actor, COALESCE(command.actor->'causation', '[]') INTO actor, causation
      FROM session_actions AS command
      WHERE 'action:' || command.id::text = session_row.source_action_id
        AND command.status = 'running' ORDER BY command.created_at DESC LIMIT 1;
  END IF;
  actor := COALESCE(actor, jsonb_build_object('kind', 'system', 'code', event_kind));
  INSERT INTO project_events(project_id, source, kind, external_id, occurred_at, payload)
  VALUES(session_row.project_id, 'session', event_kind, gen_random_uuid()::text, now(), jsonb_build_object(
    'sessionId', session_row.id, 'agentId', session_row.agent_id,
    'externalUserId', session_row.external_user_id,
    'session', jsonb_build_object('id', session_row.id, 'key', session_row.chat_key,
      'title', session_row.title,
      'status', session_row.status, 'workStatus', session_row.work_status,
      'activity', session_row.activity, 'parentSessionId', session_row.parent_session_id,
      'stateRevision', session_row.state_revision, 'authorityHostId', session_row.authority_host_id,
      'authorityRevision', session_row.authority_revision),
    'actor', actor, 'causation', COALESCE(causation, '[]'), 'detail', detail));
  RETURN NEW;
END $$;

CREATE TRIGGER session_item_events AFTER INSERT OR UPDATE ON agent_items
  FOR EACH ROW EXECUTE FUNCTION publish_session_event();
CREATE TRIGGER session_turn_events AFTER INSERT OR UPDATE ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION publish_session_event();

SELECT set_config('catamorphic.suppress_session_events', 'false', true);
