import type { DB } from "@catamorphic/db";
import type {
  EnvironmentRequirements,
  EnvironmentResourcePolicy,
  WorkloadKind,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";

/**
 * Why work waits for a machine (ADR 0258): none open to it had room
 * (`capacity`), or none open to it was online (`unavailable`).
 */
export type PlacementWaitReason = "capacity" | "unavailable";

/** Where and as whom one piece of work would wait, and what it needs. */
export interface PlacementWaitTarget {
  environmentName: string;
  reason: PlacementWaitReason;
  /** The Environment's pool: node labels that must all match. */
  pool: Readonly<Record<string, string>>;
  /** Whose work it is: a member, or null for the project's own. */
  owner: string | null;
  /**
   * What a machine must offer it: what sizes a machine (resources and
   * capabilities), and the trust, isolation and agent topology it needs.
   */
  requirements: {
    resources: EnvironmentResourcePolicy;
    capabilities: readonly string[];
  } & Pick<EnvironmentRequirements, "trust" | "isolation" | "topology">;
  /** Minutes the Environment lets work wait; 0 lets a new chat fail at once. */
  waitMinutes: number;
}

/** One piece of work waiting for a machine, as the database sees it now. */
export interface PlacementWait {
  rootWorkloadId: string;
  environmentName: string;
  reason: PlacementWaitReason;
  /** Admission may be tried again: its backoff ended. */
  due: boolean;
  /** It waited as long as its Environment lets it. */
  expired: boolean;
  /** Minutes it may wait in all, or null to wait as long as it is queued. */
  limitMinutes: number | null;
}

/**
 * A wait whose caller has not tried admission within this many seconds no
 * longer counts as demand: the process holding it stopped. Waits are tried
 * at most 30 seconds apart.
 */
export const PLACEMENT_WAIT_FRESH_SECONDS = 120;

/**
 * Work waiting for a machine (ADR 0258), in Postgres: written when
 * admission finds no machine, refreshed by every retry, and gone once the
 * work has its Allocation (in that transaction), its chat closes, or
 * nothing of it is queued. A host scaling machines with demand reads it.
 * Retries back off from 5 to 30 seconds, by the database's clock.
 */
export class PlacementWaitsService {
  constructor(private readonly db: Kysely<DB>) {}

  /**
   * Record that the work waits, or refresh a wait already recorded: it
   * keeps when it started waiting and when it gives up, and is tried again
   * after its backoff. `limitMinutes` null waits as long as it is queued.
   */
  async record(args: {
    tenantId: string;
    projectId: string;
    workloadKind: WorkloadKind;
    rootWorkloadId: string;
    target: PlacementWaitTarget;
    limitMinutes: number | null;
    transaction?: Transaction<DB>;
  }): Promise<PlacementWait> {
    const { target } = args;
    // A wait nobody tried for a while (its turn was stopped, its process
    // died) starts over, rather than giving up at once.
    const stale = sql<boolean>`placement_waits.last_tried_at <= now() - make_interval(secs => ${PLACEMENT_WAIT_FRESH_SECONDS})`;
    const backoff = sql<Date>`now() + CASE WHEN ${stale} THEN interval '5 seconds' ELSE least(interval '30 seconds', greatest(interval '5 seconds', (now() - placement_waits.waiting_since) / 4)) END`;
    const expiresAt = sql<Date | null>`CASE WHEN ${stale} THEN excluded.expires_at ELSE placement_waits.expires_at END`;
    const row = await (args.transaction ?? this.db)
      .insertInto("placement_waits")
      .values({
        root_workload_id: args.rootWorkloadId,
        tenant_id: args.tenantId,
        project_id: args.projectId,
        workload_kind: args.workloadKind,
        environment_name: target.environmentName,
        pool: JSON.stringify(target.pool),
        owner: target.owner,
        requirements: JSON.stringify(target.requirements),
        reason: target.reason,
        retry_at: sql<Date>`now() + interval '5 seconds'`,
        expires_at:
          args.limitMinutes === null
            ? null
            : sql<Date>`now() + make_interval(mins => ${args.limitMinutes})`,
      })
      .onConflict((conflict) =>
        conflict.column("root_workload_id").doUpdateSet({
          environment_name: (eb) => eb.ref("excluded.environment_name"),
          pool: (eb) => eb.ref("excluded.pool"),
          owner: (eb) => eb.ref("excluded.owner"),
          requirements: (eb) => eb.ref("excluded.requirements"),
          reason: (eb) => eb.ref("excluded.reason"),
          waiting_since: sql<Date>`CASE WHEN ${stale} THEN now() ELSE placement_waits.waiting_since END`,
          expires_at: expiresAt,
          last_tried_at: sql<Date>`now()`,
          // Never past the moment it gives up, so that is noticed then.
          retry_at: sql<Date>`least(${backoff}, coalesce(${expiresAt}, ${backoff}))`,
        }),
      )
      .returning(waitColumns)
      .executeTakeFirstOrThrow();
    return waitFromRow(row);
  }

  /**
   * The work's wait, if it waits. One nobody tried for a while is not a
   * wait any more: recording it again starts it over.
   */
  async get(args: {
    rootWorkloadId: string;
  }): Promise<PlacementWait | undefined> {
    const row = await this.db
      .selectFrom("placement_waits")
      .select(waitColumns)
      .where("root_workload_id", "=", args.rootWorkloadId)
      .where(
        "last_tried_at",
        ">",
        sql<Date>`now() - make_interval(secs => ${PLACEMENT_WAIT_FRESH_SECONDS})`,
      )
      .executeTakeFirst();
    return row ? waitFromRow(row) : undefined;
  }

  /** The work no longer waits: it was placed, closed, or nothing is queued. */
  async clear(args: {
    rootWorkloadIds: readonly string[];
    transaction?: Transaction<DB>;
  }): Promise<void> {
    if (args.rootWorkloadIds.length === 0) return;
    await (args.transaction ?? this.db)
      .deleteFrom("placement_waits")
      .where("root_workload_id", "in", [...args.rootWorkloadIds])
      .execute();
  }

  /** Forget waits nobody tried for ten minutes: their callers are gone. */
  async sweep(): Promise<void> {
    await this.db
      .deleteFrom("placement_waits")
      .where("last_tried_at", "<", sql<Date>`now() - interval '10 minutes'`)
      .execute();
  }

  /**
   * A machine came online: every wait of the tenant is tried again now,
   * on whichever replica's sweep finds it first.
   */
  async wake(args: { tenantId: string }): Promise<void> {
    await this.db
      .updateTable("placement_waits")
      .set({ retry_at: sql<Date>`now()` })
      .where("tenant_id", "=", args.tenantId)
      .where("retry_at", ">", sql<Date>`now()`)
      .execute();
  }
}

const waitColumns = [
  "root_workload_id",
  "environment_name",
  "reason",
  sql<boolean>`retry_at <= now()`.as("due"),
  sql<boolean>`coalesce(expires_at <= now(), false)`.as("expired"),
  sql<
    number | null
  >`round(extract(epoch from (expires_at - waiting_since)) / 60)::int`.as(
    "limit_minutes",
  ),
] as const;

function waitFromRow(row: {
  root_workload_id: string;
  environment_name: string;
  reason: string;
  due: boolean;
  expired: boolean;
  limit_minutes: number | null;
}): PlacementWait {
  return {
    rootWorkloadId: row.root_workload_id,
    environmentName: row.environment_name,
    reason: row.reason === "unavailable" ? "unavailable" : "capacity",
    due: row.due,
    expired: row.expired,
    limitMinutes: row.limit_minutes === null ? null : Number(row.limit_minutes),
  };
}
