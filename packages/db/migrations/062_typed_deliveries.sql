-- Deliveries are typed (ADR 0219). An input records who delivered it and
-- the enablements that led to it; a person's answer carries the questions
-- it answers; a workflow's message names its run's enablement, watcher and
-- schedule, and the alert it asked for. The free-form metadata is gone.
-- A mailbox row carries an input or a session action, and what its
-- destination acts on is a column.
SELECT set_config('catamorphic.suppress_session_events', 'true', true);

-- The strings of a JSON array.
CREATE OR REPLACE FUNCTION pg_temp.strings_of(value jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE((SELECT jsonb_agg(entry) FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]' END) AS entry
    WHERE jsonb_typeof(entry) = 'string'), '[]')
$$;

-- A non-empty string, else nothing.
CREATE OR REPLACE FUNCTION pg_temp.text_of(value jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'string' THEN NULLIF(btrim(value #>> '{}'), '') END
$$;

-- A workflow sender with what its run's provenance said about it.
CREATE OR REPLACE FUNCTION pg_temp.workflow_sender(sender jsonb, provenance jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN sender->>'kind' = 'workflow' AND jsonb_typeof(provenance) = 'object'
    THEN sender || jsonb_strip_nulls(jsonb_build_object(
      'enablementId', pg_temp.text_of(provenance->'enablementId'),
      'watcher', CASE WHEN pg_temp.text_of(provenance->'watcherId') IS NOT NULL
          AND pg_temp.text_of(provenance->'sessionId') IS NOT NULL
        THEN jsonb_build_object('id', provenance->>'watcherId', 'sessionId', provenance->>'sessionId') END,
      'scheduledFor', pg_temp.text_of(provenance->'scheduledFor'),
      'firedAt', pg_temp.text_of(provenance->'firedAt')))
    ELSE sender END
$$;

-- An input with what its metadata said, as fields of its own.
CREATE OR REPLACE FUNCTION pg_temp.typed_input(input jsonb, metadata jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE input->>'kind'
    WHEN 'user_message' THEN input || CASE
      WHEN pg_temp.text_of(metadata->'questionRequestId') IS NOT NULL
        AND jsonb_typeof(metadata->'question') = 'object'
      THEN jsonb_build_object('answer', jsonb_build_object(
        'requestId', metadata->>'questionRequestId',
        'questions', CASE WHEN jsonb_typeof(metadata->'question'->'questions') = 'array'
          THEN metadata->'question'->'questions' ELSE '[]' END,
        'answers', pg_temp.strings_of(metadata->'question'->'answers')))
      ELSE '{}' END
    WHEN 'inbound_message' THEN jsonb_set(input, '{from}',
        pg_temp.workflow_sender(input->'from', metadata->'provenance'))
      || CASE WHEN input->'from'->>'kind' = 'workflow'
          AND jsonb_typeof(metadata->'workflowNotification') = 'object'
        THEN jsonb_build_object('alert', jsonb_strip_nulls(jsonb_build_object(
          'title', pg_temp.text_of(metadata->'workflowNotification'->'title'),
          'body', pg_temp.text_of(metadata->'workflowNotification'->'body'))))
        ELSE '{}' END
    ELSE input END
$$;

UPDATE agent_items
SET payload = (pg_temp.typed_input(payload, payload->'metadata') - 'metadata')
  || jsonb_build_object(
    'deliveredBy', to_jsonb(pg_temp.text_of(payload->'metadata'->'deliveredBy')),
    'causation', pg_temp.strings_of(payload->'metadata'->'causation'))
WHERE kind IN ('user_message', 'inbound_message', 'task_notification');

UPDATE agent_items SET author_payload = payload->'from'
WHERE kind = 'inbound_message' AND author_kind = 'workflow';

ALTER TABLE session_mailbox_items
  ADD COLUMN kind text NOT NULL DEFAULT 'input',
  ADD COLUMN action jsonb,
  ADD COLUMN attention boolean NOT NULL DEFAULT false,
  ADD COLUMN delivered_by text,
  ADD COLUMN owner_authored boolean NOT NULL DEFAULT false,
  ADD COLUMN causation jsonb NOT NULL DEFAULT '[]',
  ALTER COLUMN input DROP NOT NULL,
  ALTER COLUMN delivery_mode DROP NOT NULL;

-- A forwarded session action travelled as a message carrying it.
UPDATE session_mailbox_items
SET kind = 'action',
    action = jsonb_build_object(
      'operation', metadata->'sessionAction'->>'operation',
      'args', COALESCE(metadata->'sessionAction'->'args', '{}'),
      'actor', pg_temp.workflow_sender(
        COALESCE(input->'author', input->'from'), metadata->'sessionAction'->'provenance')),
    causation = pg_temp.strings_of(metadata->'sessionAction'->'causation'),
    input = NULL,
    delivery_mode = NULL
WHERE jsonb_typeof(metadata->'sessionAction') = 'object';

UPDATE session_mailbox_items
SET input = pg_temp.typed_input(input, metadata),
    attention = COALESCE(metadata->>'attention' = 'required', false),
    delivered_by = pg_temp.text_of(metadata->'deliveredBy'),
    owner_authored = COALESCE(metadata->'ownerAuthored' = 'true'::jsonb, false),
    causation = pg_temp.strings_of(metadata->'causation')
WHERE kind = 'input';

ALTER TABLE session_mailbox_items
  ALTER COLUMN kind DROP DEFAULT,
  DROP COLUMN metadata,
  ADD CONSTRAINT chk_session_mailbox_kind CHECK (kind IN ('input', 'action')),
  ADD CONSTRAINT chk_session_mailbox_delivery CHECK (CASE kind
    WHEN 'input' THEN input IS NOT NULL AND delivery_mode IS NOT NULL AND action IS NULL
    ELSE action IS NOT NULL AND input IS NULL AND delivery_mode IS NULL END),
  ADD CONSTRAINT chk_session_mailbox_causation CHECK (jsonb_typeof(causation) = 'array');

-- Workflow-facing session events read an input's causation from its field.
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
        -- Emit once per reply, when it settles: added settled, or a streamed
        -- one leaving in_progress. Copied history is written with events suppressed.
        IF NEW.status = 'in_progress' OR (TG_OP = 'UPDATE' AND OLD.status <> 'in_progress') THEN
          RETURN NEW;
        END IF;
        event_kind := 'session.message-sent';
        SELECT input.* INTO input_row FROM agent_turns turn JOIN agent_items input ON input.id = turn.input_item_id
         WHERE turn.id = NEW.turn_id;
        causation := COALESCE(input_row.payload->'causation', '[]');
        actor := COALESCE(NEW.author_payload, '{}'::jsonb) || jsonb_build_object('kind', 'agent');
        detail := jsonb_build_object('messageId', NEW.id, 'content', NEW.text, 'deliveryMode', 'message_only',
          'status', NEW.status, 'turnId', NEW.turn_id);
      ELSIF NEW.kind IN ('user_message', 'inbound_message', 'task_notification') THEN
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        event_kind := 'session.message-received';
        causation := COALESCE(NEW.payload->'causation', '[]');
        actor := COALESCE(NEW.author_payload, '{}'::jsonb) || jsonb_build_object('kind', NEW.author_kind);
        detail := jsonb_build_object('messageId', NEW.id, 'content', NEW.text, 'deliveryMode', NEW.dispatch,
          'status', NEW.status, 'inputKind', NEW.kind);
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
      SELECT author_payload || jsonb_build_object('kind', author_kind), COALESCE(payload->'causation', '[]')
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

DROP FUNCTION pg_temp.typed_input(jsonb, jsonb);
DROP FUNCTION pg_temp.workflow_sender(jsonb, jsonb);
DROP FUNCTION pg_temp.text_of(jsonb);
DROP FUNCTION pg_temp.strings_of(jsonb);

SELECT set_config('catamorphic.suppress_session_events', 'false', true);
