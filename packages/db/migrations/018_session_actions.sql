ALTER TABLE agent_sessions ADD COLUMN source_action_id text;
CREATE UNIQUE INDEX agent_sessions_source_action ON agent_sessions(project_id, source_action_id) WHERE source_action_id IS NOT NULL;
CREATE TABLE session_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  actor jsonb NOT NULL,
  input jsonb NOT NULL,
  result jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  lease_expires_at timestamptz,
  lease_owner text,
  error text,
  target_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, idempotency_key)
);

-- Capture only durable domain transitions, never token/heartbeat updates. Functions
-- capture the migration's schema so embedders' search_path cannot redirect writes.
CREATE FUNCTION session_state_revision() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_setting('catamorphic.suppress_session_events', true) = 'true' THEN RETURN NEW; END IF;
  IF (NEW.status, NEW.activity, NEW.work_status, NEW.authority_revision, NEW.attention_revision)
     IS DISTINCT FROM (OLD.status, OLD.activity, OLD.work_status, OLD.authority_revision, OLD.attention_revision) THEN
    NEW.state_revision := OLD.state_revision + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_state_revision BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION session_state_revision();

CREATE FUNCTION publish_session_event() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  session_row agent_sessions%ROWTYPE;
  event_kind text;
  detail jsonb := '{}';
  actor jsonb;
  causation jsonb := '[]';
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
    IF TG_TABLE_NAME = 'agent_messages' THEN
      IF NEW.role = 'assistant' THEN
        -- Stream snapshots are not messages. Emit once when a visible segment settles;
        -- copied fork history is inserted already settled and must not fire again.
        IF TG_OP = 'INSERT' OR OLD.metadata->>'status' IS DISTINCT FROM 'in_progress'
          OR NEW.metadata->>'status' = 'in_progress' THEN RETURN NEW; END IF;
        event_kind := 'session.message-sent';
        SELECT COALESCE(message.metadata->'causation', '[]') INTO causation
          FROM agent_turns turn JOIN agent_messages message ON message.id = turn.message_id
          WHERE turn.session_id = NEW.session_id AND turn.status = 'running' LIMIT 1;
      ELSE
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        event_kind := 'session.message-received';
        causation := COALESCE(NEW.metadata->'causation', '[]');
      END IF;
      detail := jsonb_build_object('messageId', NEW.id, 'content', NEW.content, 'deliveryMode', NEW.delivery_mode, 'status', COALESCE(NEW.metadata->>'status', 'completed'));
      actor := NEW.author_payload || jsonb_build_object('kind', NEW.author_kind);
    ELSIF TG_TABLE_NAME = 'agent_session_views' THEN
      IF TG_OP = 'UPDATE' AND NEW.visibility = OLD.visibility THEN RETURN NEW; END IF;
      IF NEW.visibility <> 'archived' AND (TG_OP = 'INSERT' OR OLD.visibility <> 'archived') THEN RETURN NEW; END IF;
      event_kind := 'session.state-changed';
      detail := jsonb_build_object('visibility', NEW.visibility);
    ELSE
      IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NEW; END IF;
      event_kind := 'session.turn-changed';
      detail := jsonb_build_object('turnId', NEW.id, 'messageId', NEW.message_id, 'status', NEW.status, 'resultMessageId', NEW.result_message_id);
      SELECT author_payload || jsonb_build_object('kind', author_kind), COALESCE(metadata->'causation', '[]')
        INTO actor, causation FROM agent_messages WHERE id = NEW.message_id;
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
    'session', jsonb_build_object('id', session_row.id, 'title', session_row.title,
      'status', session_row.status, 'workStatus', session_row.work_status,
      'activity', session_row.activity, 'parentSessionId', session_row.parent_session_id,
      'stateRevision', session_row.state_revision, 'authorityHostId', session_row.authority_host_id,
      'authorityRevision', session_row.authority_revision),
    'actor', actor, 'causation', COALESCE(causation, '[]'), 'detail', detail));
  RETURN NEW;
END $$;
CREATE TRIGGER session_events AFTER INSERT OR UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION publish_session_event();
CREATE TRIGGER session_message_events AFTER INSERT OR UPDATE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION publish_session_event();
CREATE TRIGGER session_turn_events AFTER INSERT OR UPDATE ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION publish_session_event();
CREATE TRIGGER session_visibility_events AFTER INSERT OR UPDATE ON agent_session_views
  FOR EACH ROW EXECUTE FUNCTION publish_session_event();
