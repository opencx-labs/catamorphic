-- Persistent app-local storage (the durable backing of the guest runtime's
-- localStorage shim). One snapshot per (app, user): app-local state — this
-- user's todos, drafts, view preferences — that no workflow needs to see.
-- Shared/business state stays behind workflows; this is deliberately a
-- small, quota-bound KV snapshot, not a database for app data. Tenant and
-- project scoping ride the app row, like the other app_* tables.

CREATE TABLE app_storage (
  app_id            uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  external_user_id  text NOT NULL,
  -- Flat string->string map, exactly localStorage's shape.
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, external_user_id)
);
