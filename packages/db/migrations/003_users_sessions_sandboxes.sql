-- Users (schema only, no auth implementation yet)
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           varchar(255) NOT NULL UNIQUE,
  display_name    varchar(255) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Project membership (who can access which projects)
CREATE TABLE project_members (
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            varchar(20) NOT NULL DEFAULT 'editor',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Sandboxes: two types (execution pinned to commit, dev owned by user)
CREATE TABLE project_sandboxes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider        varchar(20) NOT NULL DEFAULT 'daytona',
  provider_id     varchar(255) NOT NULL,
  sandbox_type    varchar(20) NOT NULL,
  commit_sha      char(40),
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  status          varchar(20) NOT NULL DEFAULT 'creating',
  snapshot_name   varchar(255),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exec_sandbox UNIQUE NULLS NOT DISTINCT (project_id, sandbox_type, commit_sha),
  CONSTRAINT uq_dev_sandbox UNIQUE NULLS NOT DISTINCT (project_id, sandbox_type, user_id),
  CONSTRAINT chk_sandbox_type CHECK (sandbox_type IN ('execution', 'dev')),
  CONSTRAINT chk_exec_has_sha CHECK (sandbox_type != 'execution' OR commit_sha IS NOT NULL),
  CONSTRAINT chk_dev_has_user CHECK (sandbox_type != 'dev' OR user_id IS NOT NULL)
);
CREATE INDEX idx_sandboxes_project ON project_sandboxes(project_id, sandbox_type);
CREATE INDEX idx_sandboxes_user ON project_sandboxes(user_id) WHERE user_id IS NOT NULL;

-- Agent sessions (tied to a user's dev sandbox)
CREATE TABLE agent_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        varchar(20) NOT NULL DEFAULT 'codex',
  provider_session_id varchar(255),
  sandbox_id      uuid REFERENCES project_sandboxes(id) ON DELETE SET NULL,
  title           varchar(500),
  status          varchar(20) NOT NULL DEFAULT 'active',
  base_commit_sha char(40),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id);
CREATE INDEX idx_agent_sessions_user ON agent_sessions(user_id);

-- Agent messages (correlated with commits)
CREATE TABLE agent_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role            varchar(20) NOT NULL,
  content         text NOT NULL,
  commit_sha      char(40),
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
CREATE INDEX idx_agent_messages_commit ON agent_messages(commit_sha) WHERE commit_sha IS NOT NULL;
