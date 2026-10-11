-- Only people write user messages (ADR 0217). Words another agent, a
-- person's own assistant or a workflow sent are inbound messages; Work's
-- reports on tasks an agent started are task notifications. Existing
-- inputs convert by author, and mailbox deliveries carry the whole input.
SELECT set_config('catamorphic.suppress_session_events', 'true', true);

ALTER TABLE agent_items DROP CONSTRAINT agent_items_kind_check;
ALTER TABLE agent_items ADD CONSTRAINT agent_items_kind_check CHECK (kind IN (
    'user_message', 'inbound_message', 'task_notification', 'assistant_message',
    'reasoning', 'tool_call', 'command', 'file_change', 'plan', 'request',
    'subagent', 'notice', 'context_handoff'));

-- A watcher's delivery named the watcher; it was a workflow's.
CREATE FUNCTION pg_temp.inbound_sender(author jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE author->>'kind'
    WHEN 'watcher' THEN jsonb_build_object('kind', 'workflow',
      'runId', COALESCE(author->>'runId', ''), 'workflowName', author->>'watcherId')
    ELSE author END
$$;

-- What Work wrote as a system message, as the task it reported on.
CREATE FUNCTION pg_temp.notified_task(code text, idempotency_key text, notice text, body text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'type', CASE code
      WHEN 'session_notes' THEN 'followed_session'
      WHEN 'subsession_interrupted' THEN 'subsession'
      WHEN 'subsession_archived' THEN 'subsession'
      ELSE code END,
    'id', COALESCE(NULLIF(split_part(COALESCE(idempotency_key, ''), ':', 2), ''), code),
    'title', COALESCE(notice, left(split_part(body, E'\n', 1), 200)),
    'status', CASE
      WHEN code IN ('subsession_interrupted', 'subsession_archived') THEN 'stopped'
      WHEN notice ~* '(failed|expired|stopped)' THEN 'failed'
      WHEN notice ~* '(finished|done)$' THEN 'completed'
      ELSE 'update' END)
$$;

UPDATE agent_items
SET kind = 'inbound_message',
    author_payload = pg_temp.inbound_sender(author_payload),
    author_kind = pg_temp.inbound_sender(author_payload)->>'kind',
    payload = (payload - 'author')
      || jsonb_build_object('kind', 'inbound_message', 'from', pg_temp.inbound_sender(payload->'author'))
WHERE kind = 'user_message' AND author_kind IN ('agent', 'workflow', 'watcher');

-- Lines Work wrote before there were task notifications (045 kept old
-- system messages as system-authored inputs): notices, for people.
UPDATE agent_items
SET kind = 'notice',
    dispatch = NULL,
    attention = false,
    payload = (payload - 'author' - 'attachments' - 'dispatch' - 'attention'
        - 'idempotencyKey' - 'metadata')
      || jsonb_build_object('kind', 'notice',
        'code', COALESCE(NULLIF(author_payload->>'code', ''), 'system_message'),
        'data', '{}'::jsonb)
WHERE kind = 'user_message' AND author_kind = 'system'
  AND COALESCE(author_payload->>'code', '') NOT IN
    ('background_command', 'session_notes', 'subsession_interrupted', 'subsession_archived');

UPDATE agent_items
SET kind = 'task_notification',
    payload = (payload - 'author' - 'text' - 'attachments')
      || jsonb_build_object(
        'kind', 'task_notification',
        'task', pg_temp.notified_task(payload->'author'->>'code', idempotency_key,
          payload->'metadata'->>'notice', payload->>'text'),
        'summary', COALESCE(payload->'metadata'->>'notice', left(split_part(payload->>'text', E'\n', 1), 200)),
        'detail', payload->>'text',
        'source', NULL),
    text = COALESCE(payload->'metadata'->>'notice', left(split_part(payload->>'text', E'\n', 1), 200))
WHERE kind = 'user_message' AND author_kind = 'system';

-- Mailbox deliveries carry the input they become.
ALTER TABLE session_mailbox_items ADD COLUMN input jsonb;
UPDATE session_mailbox_items SET input = CASE
  WHEN author_kind = 'user' THEN jsonb_build_object('kind', 'user_message',
    'author', author_payload, 'text', content, 'attachments', '[]'::jsonb)
  WHEN author_kind = 'system' THEN jsonb_build_object('kind', 'task_notification',
    'task', pg_temp.notified_task(author_payload->>'code', idempotency_key, metadata->>'notice', content),
    'summary', COALESCE(metadata->>'notice', left(split_part(content, E'\n', 1), 200)),
    'detail', content, 'source', NULL)
  ELSE jsonb_build_object('kind', 'inbound_message',
    'from', pg_temp.inbound_sender(author_payload), 'text', content, 'attachments', '[]'::jsonb)
  END;
ALTER TABLE session_mailbox_items ALTER COLUMN input SET NOT NULL;
ALTER TABLE session_mailbox_items DROP CONSTRAINT chk_session_mailbox_author_kind;
ALTER TABLE session_mailbox_items DROP COLUMN content;
ALTER TABLE session_mailbox_items DROP COLUMN author_kind;
ALTER TABLE session_mailbox_items DROP COLUMN author_payload;

-- Workflow-facing session events (ADR 0090, 0181): every input a session
-- receives is `session.message-received`, its kind in the detail.
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
        causation := COALESCE(input_row.payload->'metadata'->'causation', '[]');
        actor := COALESCE(NEW.author_payload, '{}'::jsonb) || jsonb_build_object('kind', 'agent');
        detail := jsonb_build_object('messageId', NEW.id, 'content', NEW.text, 'deliveryMode', 'message_only',
          'status', NEW.status, 'turnId', NEW.turn_id);
      ELSIF NEW.kind IN ('user_message', 'inbound_message', 'task_notification') THEN
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        event_kind := 'session.message-received';
        causation := COALESCE(NEW.payload->'metadata'->'causation', '[]');
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

SELECT set_config('catamorphic.suppress_session_events', 'false', true);
