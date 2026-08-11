import type { DB } from "@catamorphic/db";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type { RateLimit } from "./rate-reservations-service.js";

/**
 * Host-owned limits on what one tenant may consume from resources shared by
 * every tenant: the execution queue, and third-party rate budgets.
 *
 * Workflow authors declare what their work *needs*; the embedder declares what
 * a tenant is *allowed*. Both are enforced, and the stricter one wins. A tenant
 * with no policy is unconstrained, so hosts adopt this incrementally.
 */
export interface TenantExecutionPolicy {
  tenantId: string;
  /** Ceiling on simultaneously leased execution jobs. */
  maxConcurrentJobs?: number;
  /** Ceiling on simultaneously non-terminal production runs. */
  maxActiveRuns?: number;
  /** Relative share of each claim batch once every tenant has taken one job. */
  queueWeight: number;
  /** Suspends claiming without cancelling in-flight work. */
  jobsEnabled: boolean;
  /**
   * Days this tenant's finished runs are kept, overriding the installation
   * default. Host-owned like the rest of this table: a tenant must not be able
   * to extend its own retention and grow shared storage unilaterally.
   */
  retentionDays?: number;
  /**
   * Per-bucket ceilings keyed by the author's `globalKey`. Caps an author's
   * declared capacity and refill rate; it can lower them but never raise them.
   */
  rateLimitOverrides: Record<string, TenantRateLimitOverride>;
}

export interface TenantRateLimitOverride {
  capacity?: number;
  refillRatePerSecond?: number;
}

export type UpsertTenantExecutionPolicyInput = {
  tenantId: string;
} & Partial<Omit<TenantExecutionPolicy, "tenantId">>;

export class TenantActiveRunLimitError extends Error {
  constructor(
    readonly tenantId: string,
    readonly limit: number,
  ) {
    super(`Tenant '${tenantId}' reached its limit of ${limit} active runs`);
    this.name = "TenantActiveRunLimitError";
  }
}

const DEFAULT_POLICY: Omit<TenantExecutionPolicy, "tenantId"> = {
  queueWeight: 1,
  jobsEnabled: true,
  rateLimitOverrides: {},
};

export class TenantPoliciesService {
  constructor(private readonly db: Kysely<DB>) {}

  async get(tenantId: string): Promise<TenantExecutionPolicy> {
    const row = await this.db
      .selectFrom("tenant_execution_policies")
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapPolicy(row) : { tenantId, ...DEFAULT_POLICY };
  }

  async upsert(
    input: UpsertTenantExecutionPolicyInput,
  ): Promise<TenantExecutionPolicy> {
    const overrides = input.rateLimitOverrides
      ? normalizeOverrides(input.rateLimitOverrides)
      : undefined;
    if (input.maxConcurrentJobs !== undefined) {
      requirePositiveInteger(input.maxConcurrentJobs, "maxConcurrentJobs");
    }
    if (input.maxActiveRuns !== undefined) {
      requirePositiveInteger(input.maxActiveRuns, "maxActiveRuns");
    }
    if (input.retentionDays !== undefined) {
      requirePositiveInteger(input.retentionDays, "retentionDays");
    }
    if (input.queueWeight !== undefined) {
      requirePositiveInteger(input.queueWeight, "queueWeight");
      if (input.queueWeight > 1_000) {
        throw new Error("queueWeight must not exceed 1000");
      }
    }
    const values = {
      tenant_id: input.tenantId,
      ...(input.maxConcurrentJobs === undefined
        ? {}
        : { max_concurrent_jobs: input.maxConcurrentJobs }),
      ...(input.maxActiveRuns === undefined
        ? {}
        : { max_active_runs: input.maxActiveRuns }),
      ...(input.queueWeight === undefined
        ? {}
        : { queue_weight: input.queueWeight }),
      ...(input.jobsEnabled === undefined
        ? {}
        : { jobs_enabled: input.jobsEnabled }),
      ...(input.retentionDays === undefined
        ? {}
        : { retention_days: input.retentionDays }),
      ...(overrides === undefined
        ? {}
        : { rate_limit_overrides: jsonbColumn(overrides) }),
    };
    const row = await this.db
      .insertInto("tenant_execution_policies")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("tenant_id").doUpdateSet({
          ...values,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapPolicy(row);
  }

  async delete(tenantId: string): Promise<void> {
    await this.db
      .deleteFrom("tenant_execution_policies")
      .where("tenant_id", "=", tenantId)
      .execute();
  }

  async list(): Promise<TenantExecutionPolicy[]> {
    const rows = await this.db
      .selectFrom("tenant_execution_policies")
      .selectAll()
      .orderBy("tenant_id")
      .execute();
    return rows.map(mapPolicy);
  }

  /**
   * Clamps author-declared limits to the tenant's ceilings. An override can
   * only tighten a bucket — a tenant cannot buy its way past what the workflow
   * says the third party accepts.
   */
  async applyRateOverrides(args: {
    tenantId: string;
    limits: readonly RateLimit[];
  }): Promise<readonly RateLimit[]> {
    if (args.limits.length === 0) return args.limits;
    const policy = await this.get(args.tenantId);
    return clampLimits({ limits: args.limits, policy });
  }

  /**
   * Reserves one unit of the tenant's active-run budget. Runs inside the
   * caller's transaction against a locked count so concurrent enrollment
   * cannot overshoot the cap.
   *
   * Counts only root runs. Child runs are internal fan-out from work already
   * admitted, and there is no safe way to refuse one — a parent suspended on a
   * child it was never allowed to create could never finish. Bounding
   * enrollment bounds the fan-out that follows from it.
   */
  async assertActiveRunCapacity(args: {
    trx: Transaction<DB>;
    tenantId: string;
  }): Promise<void> {
    const policy = await args.trx
      .selectFrom("tenant_execution_policies")
      .where("tenant_id", "=", args.tenantId)
      .select("max_active_runs")
      .forUpdate()
      .executeTakeFirst();
    const limit = policy?.max_active_runs;
    if (!limit) return;
    const active = await args.trx
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("projects.tenant_id", "=", args.tenantId)
      .where("workflow_runs.parent_run_id", "is", null)
      .where("workflow_runs.status", "not in", [
        "completed",
        "failed",
        "canceled",
      ])
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    if (Number(active.count) >= limit) {
      throw new TenantActiveRunLimitError(args.tenantId, limit);
    }
  }
}

export function clampLimits(args: {
  limits: readonly RateLimit[];
  policy: TenantExecutionPolicy;
}): readonly RateLimit[] {
  return args.limits.map((limit) => {
    const override = args.policy.rateLimitOverrides[limit.key.globalKey];
    if (!override) return limit;
    const capacity = Math.min(limit.capacity, override.capacity ?? Infinity);
    const refillRatePerSecond = Math.min(
      limit.refillRatePerSecond,
      override.refillRatePerSecond ?? Infinity,
    );
    // A cost above the clamped capacity could never be satisfied, so keep
    // capacity able to admit one unit of the work the author declared.
    return {
      ...limit,
      capacity: Math.max(capacity, limit.cost ?? 1),
      refillRatePerSecond,
    };
  });
}

function mapPolicy(row: {
  tenant_id: string;
  max_concurrent_jobs: number | null;
  max_active_runs: number | null;
  queue_weight: number;
  jobs_enabled: boolean;
  retention_days: number | null;
  rate_limit_overrides: unknown;
}): TenantExecutionPolicy {
  return {
    tenantId: row.tenant_id,
    ...(row.max_concurrent_jobs === null
      ? {}
      : { maxConcurrentJobs: row.max_concurrent_jobs }),
    ...(row.max_active_runs === null
      ? {}
      : { maxActiveRuns: row.max_active_runs }),
    queueWeight: row.queue_weight,
    jobsEnabled: row.jobs_enabled,
    ...(row.retention_days === null
      ? {}
      : { retentionDays: row.retention_days }),
    rateLimitOverrides: readOverrides(row.rate_limit_overrides),
  };
}

function readOverrides(
  value: unknown,
): Record<string, TenantRateLimitOverride> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value).flatMap(([key, raw]) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return [];
    const record = raw as Record<string, unknown>;
    const capacity = record.capacity;
    const refill = record.refillRatePerSecond;
    const override: TenantRateLimitOverride = {
      ...(typeof capacity === "number" && capacity > 0 ? { capacity } : {}),
      ...(typeof refill === "number" && refill > 0
        ? { refillRatePerSecond: refill }
        : {}),
    };
    return Object.keys(override).length > 0 ? ([[key, override]] as const) : [];
  });
  return Object.fromEntries(entries);
}

function normalizeOverrides(
  overrides: Record<string, TenantRateLimitOverride>,
): Record<string, TenantRateLimitOverride> {
  for (const [key, override] of Object.entries(overrides)) {
    if (key.length === 0 || key.length > 500) {
      throw new Error(
        "Rate limit override keys must contain 1 to 500 characters",
      );
    }
    if (override.capacity !== undefined) {
      requirePositiveFinite(override.capacity, `${key}.capacity`);
    }
    if (override.refillRatePerSecond !== undefined) {
      requirePositiveFinite(
        override.refillRatePerSecond,
        `${key}.refillRatePerSecond`,
      );
    }
  }
  return overrides;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function jsonbColumn(value: unknown) {
  return sql<never>`${JSON.stringify(value)}::jsonb`;
}
