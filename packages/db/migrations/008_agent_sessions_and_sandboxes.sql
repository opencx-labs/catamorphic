-- Coding-agent sessions + dev sandbox tracking. Re-introduces the tables
-- dropped in 006, this time against the host-identity model: users are
-- identified by the host's external user id (a string), not a local users
-- table.

-- Long-lived sandboxes tracked per project. Dev sandboxes are keyed by
-- (project, external user); execution sandboxes pin a commit.
CREATE TABLE project_sandboxes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_id       varchar(255) NOT NULL,
  sandbox_type      varchar(20) NOT NULL,
  commit_sha        char(40),
  external_user_id  varchar(255),
  status            varchar(20) NOT NULL DEFAULT 'creating',
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exec_sandbox UNIQUE NULLS NOT DISTINCT (project_id, sandbox_type, commit_sha),
  CONSTRAINT uq_dev_sandbox UNIQUE NULLS NOT DISTINCT (project_id, sandbox_type, external_user_id),
  CONSTRAINT chk_sandbox_type CHECK (sandbox_type IN ('execution', 'dev')),
  CONSTRAINT chk_exec_has_sha CHECK (sandbox_type != 'execution' OR commit_sha IS NOT NULL),
  CONSTRAINT chk_dev_has_user CHECK (sandbox_type != 'dev' OR external_user_id IS NOT NULL)
);
CREATE INDEX idx_sandboxes_project ON project_sandboxes(project_id, sandbox_type);

-- Coding-agent sessions (one conversation against a user's dev sandbox).
CREATE TABLE agent_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_user_id    varchar(255) NOT NULL,
  provider            varchar(50) NOT NULL,
  provider_session_id varchar(255),
  sandbox_id          uuid REFERENCES project_sandboxes(id) ON DELETE SET NULL,
  title               varchar(500),
  status              varchar(20) NOT NULL DEFAULT 'active',
  base_commit_sha     char(40),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_session_status CHECK (status IN ('active', 'closed'))
);
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id);

-- Conversation history. `commit_sha` correlates an assistant message with
-- the commit that captured its changes (when a sync-back produced one).
CREATE TABLE agent_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role        varchar(20) NOT NULL,
  content     text NOT NULL,
  commit_sha  char(40),
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_message_role CHECK (role IN ('user', 'assistant', 'system'))
);
CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
