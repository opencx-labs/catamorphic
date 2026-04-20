-- Plugin packages attached to a project. v1 only supports local-disk plugins;
-- the `source` check constraint is widened when npm / git resolvers land.
CREATE TABLE project_plugins (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_name  varchar(255) NOT NULL,
  source        varchar(20) NOT NULL DEFAULT 'local',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT chk_plugin_source CHECK (source IN ('local'))
);

CREATE INDEX idx_project_plugins_project ON project_plugins(project_id);

-- Per-project secret values. Values are plaintext for v1; encryption-at-rest
-- is a follow-up. Secret names must match a secret declared by an attached
-- plugin's manifest (enforced in the application layer, not the database).
CREATE TABLE project_secrets (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          varchar(255) NOT NULL,
  value         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

CREATE INDEX idx_project_secrets_project ON project_secrets(project_id);
