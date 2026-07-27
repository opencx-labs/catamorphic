import type { DB } from "@catamorphic/db";
import type { Kysely, Selectable } from "kysely";

/**
 * Host-owned limits on what one tenant's users may do with apps. Mirrors
 * `TenantPoliciesService` (ADR 0028): written by the host through the SDK,
 * deliberately not reachable over HTTP, absent row = defaults.
 */
export interface TenantAppPolicy {
  tenantId: string;
  appsEnabled: boolean;
  maxAppsPerProject?: number;
  maxBundleBytes?: number;
  /** Origins the iframe CSP allows. Empty = default-deny. */
  allowedNetworkOrigins: string[];
  /** Hard cap intersected with each version's frozen workflow set. */
  workflowAllowlist?: string[];
}

export type UpsertTenantAppPolicyInput = {
  tenantId: string;
} & Partial<Omit<TenantAppPolicy, "tenantId">>;

export class AppsDisabledError extends Error {
  constructor(readonly tenantId: string) {
    super("Apps are disabled for this tenant");
    this.name = "AppsDisabledError";
  }
}

export class AppLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppLimitExceededError";
  }
}

const DEFAULT_POLICY: Omit<TenantAppPolicy, "tenantId"> = {
  appsEnabled: true,
  allowedNetworkOrigins: [],
};

export class AppPoliciesService {
  constructor(private readonly db: Kysely<DB>) {}

  async get(tenantId: string): Promise<TenantAppPolicy> {
    const row = await this.db
      .selectFrom("tenant_app_policies")
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapPolicy(row) : { tenantId, ...DEFAULT_POLICY };
  }

  async upsert(input: UpsertTenantAppPolicyInput): Promise<TenantAppPolicy> {
    if (input.maxAppsPerProject !== undefined) {
      requirePositiveInteger(input.maxAppsPerProject, "maxAppsPerProject");
    }
    if (input.maxBundleBytes !== undefined) {
      requirePositiveInteger(input.maxBundleBytes, "maxBundleBytes");
    }
    for (const origin of input.allowedNetworkOrigins ?? []) {
      requireHttpsOrigin(origin);
    }
    const now = new Date();
    const row = await this.db
      .insertInto("tenant_app_policies")
      .values({
        tenant_id: input.tenantId,
        apps_enabled: input.appsEnabled ?? true,
        max_apps_per_project: input.maxAppsPerProject ?? null,
        max_bundle_bytes: input.maxBundleBytes ?? null,
        allowed_network_origins: JSON.stringify(
          input.allowedNetworkOrigins ?? [],
        ),
        workflow_allowlist: input.workflowAllowlist
          ? JSON.stringify(input.workflowAllowlist)
          : null,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("tenant_id").doUpdateSet({
          apps_enabled: input.appsEnabled ?? true,
          max_apps_per_project: input.maxAppsPerProject ?? null,
          max_bundle_bytes: input.maxBundleBytes ?? null,
          allowed_network_origins: JSON.stringify(
            input.allowedNetworkOrigins ?? [],
          ),
          workflow_allowlist: input.workflowAllowlist
            ? JSON.stringify(input.workflowAllowlist)
            : null,
          updated_at: now,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapPolicy(row);
  }
}

function mapPolicy(
  row: Selectable<DB["tenant_app_policies"]>,
): TenantAppPolicy {
  return {
    tenantId: row.tenant_id,
    appsEnabled: row.apps_enabled,
    maxAppsPerProject: row.max_apps_per_project ?? undefined,
    maxBundleBytes:
      row.max_bundle_bytes === null ? undefined : Number(row.max_bundle_bytes),
    allowedNetworkOrigins: stringArray(row.allowed_network_origins),
    workflowAllowlist:
      row.workflow_allowlist === null
        ? undefined
        : stringArray(row.workflow_allowlist),
  };
}

function stringArray(value: unknown): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireHttpsOrigin(origin: string): void {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) {
    throw new Error(
      `Network origins must be plain https origins; got '${origin}'`,
    );
  }
}
