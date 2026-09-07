CREATE TABLE worker_nodes (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  authority_id text NOT NULL,
  descriptor jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_nodes_authority ON worker_nodes (tenant_id, authority_id);
