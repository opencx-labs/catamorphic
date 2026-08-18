-- Publications (ADR 0055): a document (a program path at the shared main,
-- or a store path) bound to an audience and served at a stable URL —
-- `members` (anyone who may use the project, through the host's auth) or
-- `public` (an anonymous, read-only identity scoped to exactly this one
-- document — the only non-host identity there is). Revocation is a
-- timestamp; the row keeps who published what.

CREATE TABLE publications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- URL handle, unique per project (random by default).
  slug         text NOT NULL,
  path         text NOT NULL,
  audience     text NOT NULL CHECK (audience IN ('public', 'members')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  UNIQUE (project_id, slug)
);
