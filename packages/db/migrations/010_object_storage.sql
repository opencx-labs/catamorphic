-- Host-injected Postgres object storage for origins, bundles and encrypted vaults.
CREATE TABLE stored_objects (
  key text PRIMARY KEY,
  data bytea NOT NULL,
  etag uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
