-- Agents submit typed results (ADR 0323): an accepted `submit_result` value
-- is an item of its own kind, and recording one is the session event
-- `session.result-recorded`, published like the others by the trigger.
ALTER TABLE agent_items DROP CONSTRAINT agent_items_kind_check;
ALTER TABLE agent_items ADD CONSTRAINT agent_items_kind_check CHECK (kind IN (
    'user_message', 'inbound_message', 'task_notification', 'assistant_message',
    'reasoning', 'tool_call', 'command', 'file_change', 'plan', 'request',
    'subagent', 'notice', 'context_handoff', 'result'));

-- Readers take a chat's results by kind, newest first.
CREATE INDEX agent_items_results ON agent_items (session_id, created_at DESC) WHERE kind = 'result';

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
      ELSIF NEW.kind = 'result' THEN
        -- An accepted result, once, when it is recorded: mid-turn (ADR 0323).
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        event_kind := 'session.result-recorded';
        SELECT input.* INTO input_row FROM agent_turns turn JOIN agent_items input ON input.id = turn.input_item_id
         WHERE turn.id = NEW.turn_id;
        causation := COALESCE(input_row.payload->'causation', '[]');
        actor := jsonb_build_object('kind', 'agent', 'sessionId', NEW.session_id, 'agentId', session_row.agent_id);
        detail := jsonb_build_object('resultId', NEW.id, 'name', NEW.payload->'name', 'value', NEW.payload->'value',
          'turnId', NEW.turn_id, 'attemptId', NEW.attempt_id, 'input', NEW.payload->'input',
          'commit', NEW.payload->'commit', 'recordedAt', NEW.payload->'createdAt');
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
