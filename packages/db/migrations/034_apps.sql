-- User-built frontend apps. Which apps exist is defined by the project repo
-- (directories under apps/ with a package.json) — these tables never act as a
-- registry. An `apps` row is created lazily on first build and anchors built
-- artifacts, publish state, and (later) the frozen authorization set.
CREATE TABLE apps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          varchar(100) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_app_project_name UNIQUE (project_id, name),
  -- Directory name under apps/. Constrained so it can never traverse paths.
  CONSTRAINT chk_app_name CHECK (name ~ '^[a-z0-9][a-z0-9-]*$')
);

CREATE INDEX idx_apps_project ON apps(project_id);

-- Append-only build history. Every build inserts a new row — preview rows are
-- pruned by count, published rows are permanent. Versions are never mutated in
-- place, so a build can always be attributed to the exact version id it
-- produced.
CREATE TABLE app_versions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                      uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind                        varchar(20) NOT NULL,
  status                      varchar(20) NOT NULL DEFAULT 'building',
  -- Commit the bundle was built from. NULL only for previews, which build the
  -- user's mutable dev tree.
  commit_sha                  varchar(64),
  built_by_external_user_id   varchar(255) NOT NULL,
  -- Bundle bytes live in the host-injected bundle store under these keys.
  bundle_key                  text,
  css_key                     text,
  bundle_bytes                bigint,
  -- Workflows this version may invoke, frozen at build time from the app's
  -- resolved imports. Re-derivable from the commit; persisted as the
  -- enforcement set so the broker never re-parses per call.
  allowed_workflows           jsonb,
  error                       text,
  is_active                   boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  ready_at                    timestamptz,
  published_at                timestamptz,
  CONSTRAINT chk_app_version_kind CHECK (kind IN ('preview', 'published')),
  CONSTRAINT chk_app_version_status CHECK (status IN ('building', 'ready', 'failed')),
  CONSTRAINT chk_published_has_sha CHECK (kind != 'published' OR commit_sha IS NOT NULL),
  CONSTRAINT chk_active_is_published CHECK (NOT is_active OR kind = 'published')
);

-- At most one active (live) published version per app.
CREATE UNIQUE INDEX uq_app_active_version ON app_versions(app_id) WHERE is_active;

CREATE INDEX idx_app_versions_app ON app_versions(app_id, created_at DESC);
