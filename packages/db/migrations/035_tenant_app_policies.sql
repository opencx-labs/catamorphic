-- Host-owned limits on what one tenant's users may do with apps. Mirrors
-- tenant_execution_policies (ADR 0028): deliberately not reachable over HTTP —
-- the host writes it through the SDK from its own admin surface. A tenant with
-- no row gets the defaults.
CREATE TABLE tenant_app_policies (
  tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  apps_enabled               boolean NOT NULL DEFAULT true,
  max_apps_per_project       integer,
  max_bundle_bytes           bigint,
  -- Origins the iframe CSP allows apps to fetch from. Empty = default-deny:
  -- an app talks to its own workflows and nothing else.
  allowed_network_origins    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Optional hard cap on app-callable workflows, intersected with each
  -- version's frozen set. Null = no extra restriction.
  workflow_allowlist         jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_max_apps_positive
    CHECK (max_apps_per_project IS NULL OR max_apps_per_project > 0),
  CONSTRAINT chk_max_bundle_positive
    CHECK (max_bundle_bytes IS NULL OR max_bundle_bytes > 0)
);
