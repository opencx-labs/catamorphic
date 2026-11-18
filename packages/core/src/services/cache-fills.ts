import type { DB } from "@catamorphic/db";
import { type ProjectManager, shellQuote } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  cacheVolumeKey,
  followProcess,
  resolveSetupEgress,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { type Kysely, sql } from "kysely";
import { type Identity, projectPrincipalIdentity } from "../identity.js";
import {
  allocationSandboxProvider,
  withAllocationSandboxPolicy,
} from "./allocation-sandbox-provider.js";
import { CACHE_PROVENANCE_FILE, queueMachineFill } from "./cache-mounts.js";
import type {
  ExecutionAllocation,
  ExecutionAllocationsService,
} from "./execution-allocations-service.js";
import {
  admissionPolicy,
  type ExecutionEnvironmentsService,
} from "./execution-environments-service.js";
import { readProgramFile } from "./program-reader.js";
import {
  DEFAULT_CACHE_FILL_TIMEOUT_MINUTES,
  DEFAULT_CACHE_SIZE_MB,
  type EnvironmentCache,
  type ProjectEnvironmentDefinition,
  type ProjectEnvironmentsService,
  parseProjectEnvironmentPolicy,
} from "./project-environments-service.js";
import { seedSandboxBase } from "./sandbox-git.js";
import type { SecretsService } from "./secrets-service.js";
import { SecretMask } from "./sessions/secret-mask.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";

const tracer = getTracer("@catamorphic/core");

/** Tries of one fill before it fails, counting runs a lost replica left. */
export const CACHE_FILL_ATTEMPTS = 3;

/** How long a replica holds a fill it runs without renewing the claim. */
const CLAIM_MS = 2 * 60_000;

/** A fill still waiting for room on its machine after this fails. */
const QUEUE_LIMIT_MINUTES = 60;

/** Lines of a failed fill's output kept with its error. */
const LOG_TAIL_CHARS = 4_000;

/** Fills one pass starts. */
const CLAIM_LIMIT = 8;

/** Secret values shorter than this are not searched for in a cache. */
const SECRET_SCAN_MIN_LENGTH = 8;

/**
 * A shell prefix setting `$p` to a cache's path in the sandbox: `~` is the
 * sandbox user's home, as the mount resolved it.
 */
function cacheTarget(path: string): string {
  return `p=${shellQuote(path)}; case "$p" in "~") p="$HOME";; "~/"*) p="$HOME/\${p#\\~/}";; esac`;
}

/** The process a fill runs as in its sandbox. */
const FILL_PROCESS_NAME = "Cache fill";

/** A fill's state as operators and workflows see it (ADR 0334). */
export interface CacheFillState {
  id: string;
  environment: string;
  cache: string;
  machine: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "evicted";
  reason: "requested" | "first-use";
  commit: string | null;
  generation: number | null;
  attempts: number;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  lastUsedAt: string | null;
}

/** One cache's copies across machines, and its latest fill on each. */
export interface EnvironmentCacheState {
  environment: string;
  cache: string;
  path: string;
  sizeMb: number;
  copies: Array<{
    machine: string;
    generation: number;
    commit: string | null;
    filledAt: string | null;
    sizeBytes: number | null;
    lastUsedAt: string | null;
  }>;
  fills: CacheFillState[];
}

/** A fill request the program does not allow. */
export class CacheFillRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheFillRefusedError";
  }
}

type FillRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  environment_name: string;
  cache_name: string;
  worker_node_id: string | null;
  commit_sha: string | null;
  reason: string;
  status: string;
  generation: string | number | bigint | null;
  attempts: number;
  size_bytes: string | number | bigint | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  last_used_at: Date | null;
};

/** The fill ids a request row keeps. */
function idsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

function stateOf(row: FillRow): CacheFillState {
  const status = row.status as CacheFillState["status"];
  return {
    id: row.id,
    environment: row.environment_name,
    cache: row.cache_name,
    machine: row.worker_node_id,
    status,
    reason: row.reason === "first-use" ? "first-use" : "requested",
    commit: row.commit_sha,
    generation: row.generation === null ? null : Number(row.generation),
    attempts: row.attempts,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    error: row.error,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

/**
 * The project's Environment caches (ADR 0334): fill requests, the fills a
 * dispatch pass runs on each machine, eviction, and their state.
 */
export class CacheFillsService {
  /** Fills this process runs, so a host (or a test) can wait for them. */
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      projectManager: ProjectManager;
      projectEnvironments: ProjectEnvironmentsService;
      executionEnvironments: ExecutionEnvironmentsService;
      executionAllocations: ExecutionAllocationsService;
      /** Read per call: constructed after this service. */
      secrets?: () => Pick<SecretsService, "resolveForSandbox"> | undefined;
      /** Copies no sandbox mounted for this long are evicted. */
      retentionDays: number;
      /** How often a running fill renews its claim; a quarter of it by default. */
      claimRenewMs?: number;
    },
  ) {}

  /**
   * Fill a cache from a published revision of `main` (ADR 0334): on every
   * machine holding a copy, or on one placement chooses when none does. The
   * command is the cache's own; `commit`, when given, must be a revision
   * Work published, and is the published main otherwise. Idempotent per
   * key: a retry answers with the fills the first call queued.
   */
  async request(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    cache: string;
    commit?: string;
    idempotencyKey: string;
  }): Promise<{ fills: CacheFillState[] }> {
    return withSpan(
      {
        tracer,
        name: "environment.cache.fill_request",
        attributes: {
          "catamorphic.project.id": args.projectId,
          "catamorphic.environment.name": args.environment,
          "catamorphic.cache.name": args.cache,
        },
      },
      async () => {
        const existing = await this.deps.db
          .selectFrom("environment_cache_requests")
          .selectAll()
          .where("project_id", "=", args.projectId)
          .where("idempotency_key", "=", args.idempotencyKey)
          .executeTakeFirst();
        if (existing)
          return { fills: await this.fills(idsOf(existing.fill_ids)) };
        const commit = await this.liveRevision({
          tenantId: args.identity.tenantId,
          projectId: args.projectId,
          ...(args.commit !== undefined ? { commit: args.commit } : {}),
        });
        const definition = await this.declaredAt({
          tenantId: args.identity.tenantId,
          projectId: args.projectId,
          environment: args.environment,
          commit,
        });
        if (!definition?.caches?.[args.cache])
          throw new CacheFillRefusedError(
            `Environment '${args.environment}' declares no cache '${args.cache}' at ${commit.slice(0, 12)}, the revision it would fill from`,
          );
        const holders = await this.deps.db
          .selectFrom("environment_cache_fills as fill")
          .innerJoin("worker_nodes as node", "node.id", "fill.worker_node_id")
          .select("fill.worker_node_id")
          .distinct()
          .where("fill.project_id", "=", args.projectId)
          .where("fill.environment_name", "=", args.environment)
          .where("fill.cache_name", "=", args.cache)
          .where("fill.status", "=", "succeeded")
          .where("node.enabled", "=", true)
          .execute();
        const nodes: Array<string | null> = holders.length
          ? holders.map((row) => row.worker_node_id)
          : [null];
        const ids: string[] = [];
        for (const node of nodes) {
          const id = await queueMachineFill({
            db: this.deps.db,
            tenantId: args.identity.tenantId,
            projectId: args.projectId,
            environment: args.environment,
            cache: args.cache,
            node,
            commit,
            reason: "requested",
          });
          if (id) ids.push(id);
        }
        // A concurrent call with the same key keeps the first answer.
        await this.deps.db
          .insertInto("environment_cache_requests")
          .values({
            project_id: args.projectId,
            idempotency_key: args.idempotencyKey,
            environment_name: args.environment,
            cache_name: args.cache,
            commit_sha: commit,
            fill_ids: JSON.stringify(ids),
          })
          .onConflict((conflict) =>
            conflict.columns(["project_id", "idempotency_key"]).doNothing(),
          )
          .execute();
        const kept = await this.deps.db
          .selectFrom("environment_cache_requests")
          .select("fill_ids")
          .where("project_id", "=", args.projectId)
          .where("idempotency_key", "=", args.idempotencyKey)
          .executeTakeFirstOrThrow();
        return { fills: await this.fills(idsOf(kept.fill_ids)) };
      },
    );
  }

  /** Every declared cache of the project, its copies and recent fills. */
  async list(args: {
    identity: Identity;
    projectId: string;
  }): Promise<EnvironmentCacheState[]> {
    const policy = await this.deps.projectEnvironments.list(args);
    const rows = await this.deps.db
      .selectFrom("environment_cache_fills")
      .selectAll()
      .where("project_id", "=", args.projectId)
      .where("tenant_id", "=", args.identity.tenantId)
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();
    const states: EnvironmentCacheState[] = [];
    for (const [environment, definition] of Object.entries(
      policy.environments,
    ).sort(([left], [right]) => left.localeCompare(right)))
      for (const [cache, declared] of Object.entries(
        definition.caches ?? {},
      ).sort(([left], [right]) => left.localeCompare(right))) {
        const mine = rows.filter(
          (row) =>
            row.environment_name === environment && row.cache_name === cache,
        );
        const copies = new Map<
          string,
          EnvironmentCacheState["copies"][number]
        >();
        for (const row of [...mine].sort(
          (left, right) => Number(right.generation) - Number(left.generation),
        ))
          if (
            row.status === "succeeded" &&
            row.worker_node_id &&
            row.generation !== null &&
            !copies.has(row.worker_node_id)
          )
            copies.set(row.worker_node_id, {
              machine: row.worker_node_id,
              generation: Number(row.generation),
              commit: row.commit_sha,
              filledAt: row.finished_at?.toISOString() ?? null,
              sizeBytes:
                row.size_bytes === null ? null : Number(row.size_bytes),
              lastUsedAt: row.last_used_at?.toISOString() ?? null,
            });
        states.push({
          environment,
          cache,
          path: declared.path,
          sizeMb: declared.sizeMb ?? DEFAULT_CACHE_SIZE_MB,
          copies: [...copies.values()],
          fills: mine.slice(0, 20).map(stateOf),
        });
      }
    return states;
  }

  /**
   * One pass (ADR 0334): evict copies nobody used, fail fills that waited
   * too long, and start the fills that are due on this replica. Fills run
   * in the background; {@link drain} waits for them.
   */
  async dispatch(): Promise<number> {
    await this.evict();
    const claimed = await this.claim();
    for (const fill of claimed) {
      const run = this.run(fill)
        .catch((error: unknown) =>
          console.warn(`[catamorphic] Cache fill ${fill.id} failed`, error),
        )
        .finally(() => this.running.delete(run));
      this.running.add(run);
    }
    return claimed.length;
  }

  /** Wait for the fills this process runs. */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async fills(ids: readonly string[]): Promise<CacheFillState[]> {
    if (ids.length === 0) return [];
    const rows = await this.deps.db
      .selectFrom("environment_cache_fills")
      .selectAll()
      .where("id", "in", [...ids])
      .execute();
    return ids
      .map((id) => rows.find((row) => row.id === id))
      .filter((row): row is (typeof rows)[number] => row !== undefined)
      .map(stateOf);
  }

  /**
   * The revision a fill runs at (ADR 0334): one that went live through the
   * project's deploy gate (ADR 0331), `applied`, never one pending,
   * deploying, failed or superseded. `commit` names one; by default the
   * latest.
   */
  private async liveRevision(args: {
    tenantId: string;
    projectId: string;
    commit?: string;
  }): Promise<string> {
    const commit = args.commit?.toLowerCase();
    if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit))
      throw new CacheFillRefusedError(
        `'${args.commit}' is not a commit: a cache fills only from a revision of main that went live, named by its full commit`,
      );
    const row = await this.deps.db
      .selectFrom("published_revisions")
      .select("commit_sha")
      .where("project_id", "=", args.projectId)
      .where("tenant_id", "=", args.tenantId)
      .where("status", "=", "applied")
      .$if(commit !== undefined, (query) =>
        query.where("commit_sha", "=", commit ?? ""),
      )
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row)
      throw new CacheFillRefusedError(
        commit !== undefined
          ? `Commit ${commit} is not a revision of main that went live for this project; a cache fills only from those, never from a pull request, a session branch, a draft, or a revision whose deploy is pending or failed`
          : "No revision of main has gone live for this project yet, so there is nothing to fill a cache from",
      );
    return row.commit_sha;
  }

  /**
   * The Environment as the program declares it at `commit`: the cache's
   * command, size and path, and the setup's network and secrets the fill
   * runs with, all of the one revision it checks out.
   */
  private async declaredAt(args: {
    tenantId: string;
    projectId: string;
    environment: string;
    commit: string;
  }): Promise<ProjectEnvironmentDefinition | undefined> {
    const repo = await this.deps.projectManager.openPublished({
      tenantId: args.tenantId,
      projectId: args.projectId,
    });
    try {
      const content = await readProgramFile(
        repo,
        args.commit,
        PROJECT_MANIFEST_PATH,
      );
      if (!content) return undefined;
      return parseProjectEnvironmentPolicy(JSON.parse(content)).environments[
        args.environment
      ];
    } finally {
      await repo.dispose();
    }
  }

  private async evict(): Promise<void> {
    const days = this.deps.retentionDays;
    // A copy no sandbox mounted for the retention period is never mounted
    // again; its machine prunes the volume on the same schedule.
    await this.deps.db
      .updateTable("environment_cache_fills")
      .set({ status: "evicted" })
      .where("status", "=", "succeeded")
      .where(
        sql<boolean>`coalesce(last_used_at, finished_at, created_at) < now() - make_interval(days => ${days})`,
      )
      .execute();
    await this.deps.db
      .deleteFrom("environment_cache_fills")
      .where("status", "in", ["failed", "evicted"])
      .where(
        sql<boolean>`coalesce(finished_at, created_at) < now() - make_interval(days => ${days})`,
      )
      .execute();
    await this.deps.db
      .deleteFrom("environment_cache_requests")
      .where(sql<boolean>`created_at < now() - make_interval(days => ${days})`)
      .execute();
    await this.deps.db
      .updateTable("environment_cache_fills")
      .set({
        status: "failed",
        error: `Waited ${QUEUE_LIMIT_MINUTES} minutes for room on its machine`,
        finished_at: sql<Date>`now()`,
      })
      .where("status", "=", "queued")
      .where(
        sql<boolean>`queued_at < now() - make_interval(mins => ${QUEUE_LIMIT_MINUTES})`,
      )
      // Waiting behind a fill of the same cache is not waiting for room.
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("environment_cache_fills as ahead")
              .select("ahead.id")
              .whereRef(
                "ahead.project_id",
                "=",
                "environment_cache_fills.project_id",
              )
              .whereRef(
                "ahead.environment_name",
                "=",
                "environment_cache_fills.environment_name",
              )
              .whereRef(
                "ahead.cache_name",
                "=",
                "environment_cache_fills.cache_name",
              )
              .whereRef(
                "ahead.worker_node_id",
                "=",
                "environment_cache_fills.worker_node_id",
              )
              .where("ahead.status", "=", "running"),
          ),
        ),
      )
      .execute();
  }

  /**
   * Claim due fills: queued ones whose machine runs no fill of that cache,
   * and running ones whose replica stopped renewing (tried again with a
   * new generation, up to {@link CACHE_FILL_ATTEMPTS}). Each claimed fill
   * gets a new generation, so no attempt writes into another's volume.
   */
  private async claim(): Promise<FillRow[]> {
    return this.deps.db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom("environment_cache_fills as fill")
        .selectAll("fill")
        .where((eb) =>
          eb.or([
            eb.and([
              eb("fill.status", "=", "queued"),
              eb.or([
                eb("fill.retry_at", "is", null),
                eb("fill.retry_at", "<=", sql<Date>`now()`),
              ]),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("environment_cache_fills as other")
                    .select("other.id")
                    .whereRef("other.project_id", "=", "fill.project_id")
                    .whereRef(
                      "other.environment_name",
                      "=",
                      "fill.environment_name",
                    )
                    .whereRef("other.cache_name", "=", "fill.cache_name")
                    .whereRef(
                      "other.worker_node_id",
                      "=",
                      "fill.worker_node_id",
                    )
                    .where("other.status", "=", "running"),
                ),
              ),
            ]),
            eb.and([
              eb("fill.status", "=", "running"),
              eb("fill.claimed_until", "<", sql<Date>`now()`),
            ]),
          ]),
        )
        .orderBy("fill.created_at")
        .limit(CLAIM_LIMIT)
        .forUpdate()
        .skipLocked()
        .execute();
      const claimed: FillRow[] = [];
      for (const row of due) {
        if (row.attempts >= CACHE_FILL_ATTEMPTS) {
          // What its last attempt left on the machine goes too: the
          // machine's cleanup destroys a released Allocation's sandbox and
          // gives its reservation back.
          for (const left of await trx
            .selectFrom("execution_allocations")
            .select("id")
            .where("root_workload_id", "=", row.id)
            .where("status", "=", "active")
            .execute())
            await this.deps.executionAllocations.release({
              identity: projectPrincipalIdentity({
                tenantId: row.tenant_id,
                projectId: row.project_id,
                environment: row.environment_name,
              }),
              allocationId: left.id,
              reason: "retired",
              transaction: trx,
            });
          await trx
            .updateTable("environment_cache_fills")
            .set({
              status: "failed",
              error:
                row.error ??
                `Its replica stopped ${CACHE_FILL_ATTEMPTS} times while it ran`,
              finished_at: sql<Date>`now()`,
              claimed_until: null,
            })
            .where("id", "=", row.id)
            .execute();
          continue;
        }
        const updated = await trx
          .updateTable("environment_cache_fills")
          .set({
            status: "running",
            attempts: row.attempts + 1,
            generation: sql<string>`nextval('environment_cache_generations')`,
            claimed_until: sql<Date>`now() + make_interval(secs => ${CLAIM_MS / 1000})`,
            started_at: sql<Date>`now()`,
            retry_at: null,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        claimed.push(updated);
      }
      return claimed;
    });
  }

  /** Run one claimed fill to its end. */
  private async run(fill: FillRow): Promise<void> {
    const generation = Number(fill.generation);
    const mine = () =>
      this.deps.db
        .updateTable("environment_cache_fills")
        .where("id", "=", fill.id)
        .where("status", "=", "running")
        .where("generation", "=", String(generation));
    // A run that can no longer renew its claim stops: another replica
    // may have taken the fill over.
    const lost = new AbortController();
    const renew = setInterval(
      () => {
        void mine()
          .set({
            claimed_until: sql<Date>`now() + make_interval(secs => ${CLAIM_MS / 1000})`,
          })
          .executeTakeFirst()
          .then((result) => {
            if (Number(result.numUpdatedRows) === 0)
              lost.abort(new Error("This fill's claim moved to another run"));
          })
          .catch(() => {});
      },
      this.deps.claimRenewMs ?? CLAIM_MS / 4,
    );
    renew.unref?.();
    let mask = new SecretMask({});
    const fail = async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await mine()
        .set({
          status: "failed",
          error: mask.text(message).slice(-LOG_TAIL_CHARS - 500),
          finished_at: sql<Date>`now()`,
          claimed_until: null,
        })
        .execute();
    };
    try {
      await withSpan(
        {
          tracer,
          name: "environment.cache.fill",
          attributes: {
            "catamorphic.project.id": fill.project_id,
            "catamorphic.environment.name": fill.environment_name,
            "catamorphic.cache.name": fill.cache_name,
            "catamorphic.cache.generation": generation,
          },
        },
        async () => {
          const outcome = await this.fill({
            fill,
            generation,
            signal: lost.signal,
            onSecrets: (values) => {
              mask = new SecretMask(
                Object.fromEntries(
                  Object.entries(values).map(([name, value]) => [
                    name,
                    [value],
                  ]),
                ),
              );
            },
          });
          if (outcome === "requeued") return;
          lost.signal.throwIfAborted();
          // Published in one statement, once its sandbox is gone: every
          // sandbox made from now on mounts this generation.
          await mine()
            .set({
              status: "succeeded",
              size_bytes: String(outcome.sizeBytes),
              commit_sha: outcome.commit,
              finished_at: sql<Date>`now()`,
              last_used_at: sql<Date>`now()`,
              claimed_until: null,
              error: null,
            })
            .execute();
        },
      );
    } catch (error) {
      await fail(error);
    } finally {
      clearInterval(renew);
      // The fill waiting behind this one starts its wait now.
      await this.deps.db
        .updateTable("environment_cache_fills")
        .set({ queued_at: sql<Date>`now()` })
        .where("project_id", "=", fill.project_id)
        .where("environment_name", "=", fill.environment_name)
        .where("cache_name", "=", fill.cache_name)
        .where("worker_node_id", "=", fill.worker_node_id ?? "")
        .where("status", "=", "queued")
        .execute()
        .catch(() => {});
    }
  }

  /**
   * The fill itself: its own Allocation on the machine, a fresh sandbox of
   * the Environment's image holding a live revision alone, on that
   * revision's setup network, with the one cache generation writable.
   * Every step goes through the Allocation's guard, so a released
   * Allocation or a lost machine lease stops it, and so does a lost claim.
   * Answers its size and commit, or `requeued` when the machine had no room.
   */
  private async fill(args: {
    fill: FillRow;
    generation: number;
    signal: AbortSignal;
    onSecrets: (values: Record<string, string>) => void;
  }): Promise<{ sizeBytes: number; commit: string } | "requeued"> {
    const { fill, signal } = args;
    const identity = projectPrincipalIdentity({
      tenantId: fill.tenant_id,
      projectId: fill.project_id,
      environment: fill.environment_name,
    });
    // The revision it fills from, and the cache as that revision declares
    // it: command, size, path, and the setup's network and secrets.
    const commit = await this.liveRevision({
      tenantId: fill.tenant_id,
      projectId: fill.project_id,
      ...(fill.commit_sha ? { commit: fill.commit_sha } : {}),
    });
    const definition = await this.declaredAt({
      tenantId: fill.tenant_id,
      projectId: fill.project_id,
      environment: fill.environment_name,
      commit,
    });
    const cache: EnvironmentCache | undefined =
      definition?.caches?.[fill.cache_name];
    if (!definition || !cache)
      throw new CacheFillRefusedError(
        `Environment '${fill.environment_name}' declares no cache '${fill.cache_name}' at ${commit.slice(0, 12)}, the live revision it fills from`,
      );
    const workload = definition.workloads.includes("agent")
      ? "agent"
      : "workflow";
    let admission: Awaited<ReturnType<ExecutionEnvironmentsService["admit"]>>;
    try {
      admission = await this.deps.executionEnvironments.admit({
        identity,
        projectId: fill.project_id,
        owner: null,
        environment: fill.environment_name,
        ...(fill.worker_node_id ? { workerNodeId: fill.worker_node_id } : {}),
        requirements: { workload },
      });
    } catch (error) {
      if (error instanceof EnvironmentCapacityError)
        return this.requeue(fill, args.generation, error.message);
      throw error;
    }
    const node = admission.runtime.workerNodeId;
    const machine = admission.runtime.sandboxProvider;
    if (!node || !machine)
      throw new Error(
        "Caches live on machines: this Environment's placement has none",
      );
    if (fill.worker_node_id && node !== fill.worker_node_id)
      return this.requeue(
        fill,
        args.generation,
        "Its machine is not available to this Environment now",
      );
    if (!fill.worker_node_id) {
      // A request that found no copy anywhere takes the machine admission
      // chose; one already filling there makes this one redundant.
      const placed = await this.deps.db
        .updateTable("environment_cache_fills")
        .set({ worker_node_id: node })
        .where("id", "=", fill.id)
        .where("generation", "=", String(args.generation))
        .execute()
        .then(() => true)
        .catch(() => false);
      if (!placed)
        throw new Error(
          `A fill of this cache already runs on machine ${node}; this request joined it`,
        );
    }
    const key = cacheVolumeKey({
      projectId: fill.project_id,
      environment: fill.environment_name,
      name: fill.cache_name,
      generation: args.generation,
    });
    // A run an earlier replica left: its Allocation and sandbox go first.
    await this.retireEarlier({ identity, fill, machine });
    const sandboxPolicy = admission.sandbox;
    // The revision's own setup network, else the Environment's network.
    const egress = definition.setup?.network
      ? resolveSetupEgress({ allow: definition.setup.network.allow })
      : sandboxPolicy.egress;
    const policy = admissionPolicy({ admission, connections: [] });
    let allocation: ExecutionAllocation;
    try {
      allocation = await this.deps.executionAllocations.create({
        identity,
        projectId: fill.project_id,
        environmentName: fill.environment_name,
        workloadKind: workload,
        rootWorkloadId: fill.id,
        workerNodeId: node,
        policy: {
          ...policy,
          // Nothing of the Environment's other caches or volumes, and the
          // setup's network as the sandbox's own: it never widens.
          sandbox: {
            ...(sandboxPolicy.image ? { image: sandboxPolicy.image } : {}),
            ...(sandboxPolicy.containers ? { containers: true } : {}),
            ...(egress ? { egress } : {}),
            fill: { name: fill.cache_name, path: cache.path, key },
          },
        },
      });
    } catch (error) {
      if (error instanceof EnvironmentCapacityError)
        return this.requeue(fill, args.generation, error.message);
      throw error;
    }
    await this.deps.db
      .updateTable("environment_cache_fills")
      .set({ allocation_id: allocation.id })
      .where("id", "=", fill.id)
      .execute();
    const managed = allocation.policy.binding.trust === "managed";
    const guarded = managed
      ? allocationSandboxProvider({
          db: this.deps.db,
          allocation,
          provider: machine,
          ...(admission.runtime.workerLeaseToken
            ? { workerLeaseToken: admission.runtime.workerLeaseToken }
            : {}),
        })
      : withAllocationSandboxPolicy({
          db: this.deps.db,
          allocation,
          provider: machine,
        });
    // Each step proves the Allocation is still active and the claim held.
    const step = async <T>(work: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      if (!managed) await this.requireActiveAllocation(allocation.id);
      const result = await work();
      signal.throwIfAborted();
      return result;
    };
    let sandboxId: string | undefined;
    let published = false;
    try {
      const handle = await step(() =>
        guarded.createSandbox({
          labels: { purpose: "cache-fill", projectId: fill.project_id },
        }),
      );
      sandboxId = handle.providerId;
      // The machine's cleanup finds it by its Allocation, whatever path
      // made it.
      await this.deps.db
        .updateTable("execution_allocations")
        .set({ sandbox_provider_id: handle.providerId })
        .where("id", "=", allocation.id)
        .where("sandbox_provider_id", "is", null)
        .execute();
      const id = sandboxId;
      await step(() =>
        this.seed({ fill, provider: guarded, sandboxId: id, commit }),
      );
      const env = await this.secretValues({
        identity,
        fill,
        definition,
        isolated: admission.isolated,
      });
      args.onSecrets(env);
      await step(() =>
        this.runCommand({
          provider: guarded,
          sandboxId: id,
          command: cache.fill.command,
          timeoutMs:
            (cache.fill.timeoutMinutes ?? DEFAULT_CACHE_FILL_TIMEOUT_MINUTES) *
            60_000,
          env,
          signal,
        }),
      );
      const sizeBytes = await step(() =>
        this.finish({
          provider: guarded,
          sandboxId: id,
          cache,
          fill,
          commit,
          generation: args.generation,
          secrets: env,
        }),
      );
      // Nothing the command left running may write after it is published.
      await step(() => guarded.stopSandbox(id));
      await machine.destroySandbox(id);
      sandboxId = undefined;
      published = true;
      return { sizeBytes, commit };
    } finally {
      if (sandboxId) {
        // A generation that will not be published holds nothing: what the
        // fill wrote is removed before its sandbox goes.
        if (!published)
          await this.emptyGeneration({
            provider: machine,
            sandboxId,
            path: cache.path,
          });
        await machine
          .destroySandbox(sandboxId)
          .catch((error: unknown) =>
            console.warn(
              `[catamorphic] Could not remove cache fill sandbox ${sandboxId}`,
              error,
            ),
          );
      }
      await this.deps.executionAllocations
        .release({ identity, allocationId: allocation.id, reason: "retired" })
        .catch(() => {});
    }
  }

  /** Fail unless the Allocation is still active. */
  private async requireActiveAllocation(allocationId: string): Promise<void> {
    const row = await this.deps.db
      .selectFrom("execution_allocations")
      .select("id")
      .where("id", "=", allocationId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) throw new Error("The fill's Allocation is no longer active");
  }

  /** Remove what a fill wrote into a generation that will not be published. */
  private async emptyGeneration(args: {
    provider: SandboxProvider;
    sandboxId: string;
    path: string;
  }): Promise<void> {
    await args.provider
      .executeCommand(
        args.sandboxId,
        `${cacheTarget(args.path)}; find "$p" -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
        { cwd: args.provider.workspaceRoot, timeout: 600 },
      )
      .catch(() => {});
  }

  /** Back to the queue, its attempt not counted: the machine had no room. */
  private async requeue(
    fill: FillRow,
    generation: number,
    reason: string,
  ): Promise<"requeued"> {
    const backoffSeconds = Math.min(300, 30 * 2 ** Math.min(fill.attempts, 4));
    await this.deps.db
      .updateTable("environment_cache_fills")
      .set({
        status: "queued",
        attempts: Math.max(0, fill.attempts - 1),
        claimed_until: null,
        retry_at: sql<Date>`now() + make_interval(secs => ${backoffSeconds})`,
        error: reason,
      })
      .where("id", "=", fill.id)
      .where("status", "=", "running")
      .where("generation", "=", String(generation))
      .execute()
      .catch(async () => {
        // Another fill of this cache was queued meanwhile: this one ends.
        await this.deps.db
          .updateTable("environment_cache_fills")
          .set({
            status: "failed",
            error: `${reason}; a newer request waits instead`,
            finished_at: sql<Date>`now()`,
            claimed_until: null,
          })
          .where("id", "=", fill.id)
          .execute();
      });
    return "requeued";
  }

  /** Release what an earlier attempt of this fill left on its machine. */
  private async retireEarlier(args: {
    identity: Identity;
    fill: FillRow;
    machine: SandboxProvider;
  }): Promise<void> {
    const left = await this.deps.db
      .selectFrom("execution_allocations")
      .select(["id", "sandbox_provider_id"])
      .where("root_workload_id", "=", args.fill.id)
      .where("status", "=", "active")
      .execute();
    for (const row of left) {
      if (row.sandbox_provider_id)
        await args.machine
          .destroySandbox(row.sandbox_provider_id)
          .catch(() => {});
      await this.deps.executionAllocations.release({
        identity: args.identity,
        allocationId: row.id,
        reason: "retired",
      });
    }
  }

  /** The live revision's checkout alone in the project folder. */
  private async seed(args: {
    fill: FillRow;
    provider: SandboxProvider;
    sandboxId: string;
    commit: string;
  }): Promise<void> {
    const repo = await this.deps.projectManager.openEphemeral({
      tenantId: args.fill.tenant_id,
      projectId: args.fill.project_id,
    });
    try {
      await seedSandboxBase({
        provider: args.provider,
        sandboxId: args.sandboxId,
        projectDir: `${args.provider.workspaceRoot}/project`,
        sessionCopyPath: repo.repoPath,
        base: args.commit,
      });
    } finally {
      await repo.dispose();
    }
  }

  /**
   * The secrets the Environment's setup names, as a setup on its own
   * network gets them (ADR 0257), and only where the placement isolates
   * the project's work.
   */
  private async secretValues(args: {
    identity: Identity;
    fill: FillRow;
    definition: ProjectEnvironmentDefinition;
    isolated: boolean;
  }): Promise<Record<string, string>> {
    const names = args.definition.setup?.network
      ? (args.definition.setup.secrets ?? [])
      : [];
    const service = this.deps.secrets?.();
    if (!service || names.length === 0 || !args.isolated) return {};
    const resolved = await service.resolveForSandbox({
      identity: args.identity,
      projectId: args.fill.project_id,
      environment: args.fill.environment_name,
      owner: null,
    });
    return Object.fromEntries(
      Object.entries(resolved.variables).filter(([name]) =>
        names.includes(name),
      ),
    );
  }

  /** The cache's command, in the project folder, within its time. */
  private async runCommand(args: {
    provider: SandboxProvider;
    sandboxId: string;
    command: string;
    timeoutMs: number;
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<void> {
    const { provider, sandboxId } = args;
    const cwd = `${provider.workspaceRoot}/project`;
    const processes = provider.processes;
    if (!processes) {
      const result = await provider.executeCommand(sandboxId, args.command, {
        cwd,
        timeout: Math.max(1, Math.ceil(args.timeoutMs / 1000)),
        env: args.env,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `The fill command exited ${result.exitCode}:\n${result.result.slice(-LOG_TAIL_CHARS)}`,
        );
      return;
    }
    const started = await processes.startProcess({
      sandboxId,
      command: args.command,
      cwd,
      name: FILL_PROCESS_NAME,
      env: args.env,
    });
    const followed = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      timeoutMs: args.timeoutMs,
      outputLimit: LOG_TAIL_CHARS,
      signal: args.signal,
    });
    if (followed.timedOut || followed.aborted) {
      await processes
        .signalProcess({
          sandboxId,
          processId: started.processId,
          signal: "SIGKILL",
        })
        .catch(() => {});
      args.signal.throwIfAborted();
      throw new Error(
        `The fill command ran past its ${Math.round(args.timeoutMs / 60_000)} minutes:\n${followed.output.slice(-LOG_TAIL_CHARS)}`,
      );
    }
    if (followed.exitCode !== 0)
      throw new Error(
        `The fill command exited ${followed.exitCode ?? followed.signal ?? "without a status"}:\n${followed.output.slice(-LOG_TAIL_CHARS)}`,
      );
  }

  /**
   * Check the cache's size against its limit and write its provenance into
   * its root. Answers its size in bytes.
   */
  private async finish(args: {
    provider: SandboxProvider;
    sandboxId: string;
    cache: EnvironmentCache;
    fill: FillRow;
    commit: string;
    generation: number;
    /** The setup secrets the fill ran with, none of which may stay in it. */
    secrets: Record<string, string>;
  }): Promise<number> {
    const limitMb = args.cache.sizeMb ?? DEFAULT_CACHE_SIZE_MB;
    const provenance = JSON.stringify({
      cache: args.fill.cache_name,
      environment: args.fill.environment_name,
      commit: args.commit,
      ref: "main",
      fill: args.fill.id,
      generation: args.generation,
      filledAt: new Date().toISOString(),
    });
    const target = cacheTarget(args.cache.path);
    const measured = await args.provider.executeCommand(
      args.sandboxId,
      `${target}; du -sk -- "$p" | cut -f1`,
      { cwd: args.provider.workspaceRoot, timeout: 600 },
    );
    const kib = Number.parseInt(measured.result.trim(), 10);
    if (measured.exitCode !== 0 || !Number.isFinite(kib))
      throw new Error(
        `Could not measure the cache: ${measured.result.slice(-500)}`,
      );
    if (kib > limitMb * 1024)
      throw new Error(
        `The cache holds ${Math.ceil(kib / 1024)} MiB after its fill; its limit is ${limitMb} MiB (sizeMb)`,
      );
    // Every sandbox mounts what the fill leaves, the agent's included: a
    // setup secret written into it would reach them all (ADR 0257). The
    // values travel as the scan's environment, never in its command.
    const scanned = Object.entries(args.secrets).filter(
      ([, value]) => value.length >= SECRET_SCAN_MIN_LENGTH,
    );
    if (scanned.length > 0) {
      const names = scanned.map(([name]) => shellQuote(name)).join(" ");
      const found = await args.provider.executeCommand(
        args.sandboxId,
        `${target}; for n in ${names}; do v=$(printenv "$n") || continue; grep -rqF -- "$v" "$p" 2>/dev/null && echo "$n"; done; true`,
        {
          cwd: args.provider.workspaceRoot,
          timeout: 1800,
          env: Object.fromEntries(scanned),
        },
      );
      const leaked = found.result
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => scanned.some(([secret]) => secret === name));
      if (found.exitCode !== 0)
        throw new Error("Could not check the cache for the fill's secrets");
      if (leaked.length > 0)
        throw new Error(
          `The cache holds the value of ${leaked.join(", ")} after its fill, and every sandbox of the Environment would read it; it was not published. Keep secrets out of what the fill command leaves in the cache`,
        );
    }
    const written = await args.provider.executeCommand(
      args.sandboxId,
      `${target}; printf '%s\\n' ${shellQuote(provenance)} > "$p/${CACHE_PROVENANCE_FILE}"`,
      { cwd: args.provider.workspaceRoot, timeout: 60 },
    );
    if (written.exitCode !== 0)
      throw new Error(
        `Could not record what the cache holds: ${written.result.slice(-500)}`,
      );
    return kib * 1024;
  }
}
