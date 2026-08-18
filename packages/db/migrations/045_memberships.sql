-- Stock project memberships (ADR 0055): which host user holds which roles,
-- with which per-user grants, in a project. Roles themselves are committed
-- files (`roles/<slug>.json`); this table is the one piece every host would
-- otherwise rebuild identically — a stock SOURCE of roles/grants for
-- `RolesService.resolve`, which a host may use or ignore in favour of its
-- own entitlement tables. Core stores no policy: the row says "alice: csm,
-- customers acme+globex", never what a CSM may do.

CREATE TABLE memberships (
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_user_id  text NOT NULL,
  -- Role slugs, e.g. ["csm"].
  roles             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Placeholder values by param, e.g. {"customer": ["acme", "globex"]}.
  grants            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, external_user_id)
);
