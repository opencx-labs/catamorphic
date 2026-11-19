import type { DB } from "@catamorphic/db";
import {
  cacheVolumeKey,
  parseCacheVolumeKey,
  type SandboxVolume,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import type { ExecutionAllocation } from "./execution-allocations-service.js";

/** Written into each cache's root by its fill: what it holds (ADR 0334). */
export const CACHE_PROVENANCE_FILE = ".work-cache.json";

/** The most generations one mount names to retire. */
const RETIRE_LIMIT = 100;

/**
 * What a sandbox an Allocation makes mounts of its Environment's caches
 * (ADR 0334), and what to record once it exists. A fill's Allocation mounts
 * its one writable generation; any other sandbox the generation its
 * machine holds of each cache, read only. Each names the cache's other
 * generations on the machine to retire: all but the published one and the
 * one being filled. Called as the sandbox is made, so a fill published
 * since the Allocation was admitted is the one mounted.
 *
 * `settle` records what the machine did: a generation it mounted was used;
 * one it no longer had (pruned, reset, re-enrolled) is forgotten with every
 * older one, and the machine, like one that holds no copy, gets a fill.
 */
export async function cacheMounts(args: {
  db: Kysely<DB>;
  allocation: ExecutionAllocation;
}): Promise<{
  volumes: SandboxVolume[];
  settle: (handle: { skippedVolumes?: readonly string[] }) => Promise<void>;
}> {
  const { allocation } = args;
  const sandbox = allocation.policy.sandbox;
  const node = allocation.workerNodeId;
  const keyOf = (name: string, generation: number) =>
    cacheVolumeKey({
      projectId: allocation.projectId,
      environment: allocation.environmentName,
      name,
      generation,
    });
  const nothing = async () => {};
  if (sandbox?.fill) {
    const own = parseCacheVolumeKey(sandbox.fill.key)?.generation;
    const retire = node
      ? await retirable({
          db: args.db,
          allocation,
          node,
          cache: sandbox.fill.name,
          keep: own === undefined ? [] : [own],
        })
      : [];
    return {
      volumes: [
        {
          key: sandbox.fill.key,
          path: sandbox.fill.path,
          ...(retire.length > 0
            ? { retire: retire.map((n) => keyOf(sandbox.fill?.name ?? "", n)) }
            : {}),
        },
      ],
      settle: nothing,
    };
  }
  const caches = sandbox?.caches ?? [];
  if (caches.length === 0 || !node) return { volumes: [], settle: nothing };
  const copies = await machineCopies({
    db: args.db,
    projectId: allocation.projectId,
    environment: allocation.environmentName,
    node,
  });
  const volumes: SandboxVolume[] = [];
  const mounted = new Map<
    string,
    { id: string; cache: string; generation: number }
  >();
  for (const cache of caches) {
    const copy = copies.get(cache.name);
    if (!copy) continue;
    const key = keyOf(cache.name, copy.generation);
    const retire = await retirable({
      db: args.db,
      allocation,
      node,
      cache: cache.name,
      keep: [copy.generation],
    });
    volumes.push({
      key,
      path: cache.path,
      readOnly: true,
      ...(retire.length > 0
        ? { retire: retire.map((n) => keyOf(cache.name, n)) }
        : {}),
    });
    mounted.set(key, {
      id: copy.id,
      cache: cache.name,
      generation: copy.generation,
    });
  }
  const settle = async (handle: { skippedVolumes?: readonly string[] }) => {
    const skipped = new Set(handle.skippedVolumes ?? []);
    const used = [...mounted]
      .filter(([key]) => !skipped.has(key))
      .map(([, copy]) => copy.id);
    if (used.length > 0)
      await args.db
        .updateTable("environment_cache_fills")
        .set({ last_used_at: sql<Date>`now()` })
        .where("id", "in", used)
        .execute();
    const missing = caches
      .map((cache) => cache.name)
      .filter((name) => !copies.has(name));
    for (const [key, copy] of mounted) {
      if (!skipped.has(key)) continue;
      // The machine lost it: never mounted again, nor anything older.
      await args.db
        .updateTable("environment_cache_fills")
        .set({ status: "evicted" })
        .where("project_id", "=", allocation.projectId)
        .where("environment_name", "=", allocation.environmentName)
        .where("cache_name", "=", copy.cache)
        .where("worker_node_id", "=", node)
        .where("status", "=", "succeeded")
        .where("generation", "<=", String(copy.generation))
        .execute();
      missing.push(copy.cache);
    }
    if (missing.length === 0) return;
    const tenant = await args.db
      .selectFrom("execution_allocations")
      .select("tenant_id")
      .where("id", "=", allocation.id)
      .executeTakeFirst();
    if (tenant)
      for (const name of missing)
        await queueMachineFill({
          db: args.db,
          tenantId: tenant.tenant_id,
          projectId: allocation.projectId,
          environment: allocation.environmentName,
          cache: name,
          node,
          commit: null,
          reason: "first-use",
          onlyWhenIdle: true,
        });
  };
  return { volumes, settle };
}

/**
 * A cache's generations on a machine that no sandbox should keep: every
 * one but `keep`, the published one, and the one a fill is writing.
 */
async function retirable(args: {
  db: Kysely<DB>;
  allocation: ExecutionAllocation;
  node: string;
  cache: string;
  keep: readonly number[];
}): Promise<number[]> {
  const rows = await args.db
    .selectFrom("environment_cache_fills")
    .select(["generation", "status", "abandoned_generations"])
    .where("project_id", "=", args.allocation.projectId)
    .where("environment_name", "=", args.allocation.environmentName)
    .where("cache_name", "=", args.cache)
    .where("worker_node_id", "=", args.node)
    .where("generation", "is not", null)
    .orderBy("generation", "desc")
    .limit(RETIRE_LIMIT + 2)
    .execute();
  const live = rows.find((row) => row.status === "succeeded");
  const kept = new Set([
    ...args.keep,
    ...(live ? [Number(live.generation)] : []),
    ...rows
      .filter((row) => row.status === "running")
      .map((row) => Number(row.generation)),
  ]);
  // A lost claim's attempts are named too: `generation` holds the latest.
  const abandoned = rows.flatMap((row) =>
    Array.isArray(row.abandoned_generations)
      ? row.abandoned_generations.map(Number).filter(Number.isSafeInteger)
      : [],
  );
  return [
    ...new Set([...rows.map((row) => Number(row.generation)), ...abandoned]),
  ]
    .filter((generation) => generation > 0 && !kept.has(generation))
    .sort((left, right) => right - left)
    .slice(0, RETIRE_LIMIT);
}

/**
 * Each cache's copy on one machine: its succeeded fill with the highest
 * generation.
 */
export async function machineCopies(args: {
  db: Kysely<DB>;
  projectId: string;
  environment: string;
  node: string;
}): Promise<
  Map<
    string,
    {
      id: string;
      generation: number;
      commit: string | null;
      filledAt: Date | null;
    }
  >
> {
  const rows = await args.db
    .selectFrom("environment_cache_fills")
    .select(["id", "cache_name", "generation", "commit_sha", "finished_at"])
    .where("project_id", "=", args.projectId)
    .where("environment_name", "=", args.environment)
    .where("worker_node_id", "=", args.node)
    .where("status", "=", "succeeded")
    .orderBy("generation", "desc")
    .execute();
  const copies = new Map<
    string,
    {
      id: string;
      generation: number;
      commit: string | null;
      filledAt: Date | null;
    }
  >();
  for (const row of rows)
    if (!copies.has(row.cache_name) && row.generation !== null)
      copies.set(row.cache_name, {
        id: row.id,
        generation: Number(row.generation),
        commit: row.commit_sha,
        filledAt: row.finished_at,
      });
  return copies;
}

/**
 * Queue a fill of one cache on one machine, or join the one already
 * waiting there (taking the newer commit). `onlyWhenIdle` queues nothing
 * when one already runs: a first use needs a copy, not a second fill.
 */
export async function queueMachineFill(args: {
  db: Kysely<DB>;
  tenantId: string;
  projectId: string;
  environment: string;
  cache: string;
  node: string | null;
  commit: string | null;
  reason: "requested" | "first-use";
  onlyWhenIdle?: boolean;
}): Promise<string | undefined> {
  if (args.node && args.onlyWhenIdle) {
    const running = await args.db
      .selectFrom("environment_cache_fills")
      .select("id")
      .where("project_id", "=", args.projectId)
      .where("environment_name", "=", args.environment)
      .where("cache_name", "=", args.cache)
      .where("worker_node_id", "=", args.node)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (running) return running.id;
  }
  const values = {
    tenant_id: args.tenantId,
    project_id: args.projectId,
    environment_name: args.environment,
    cache_name: args.cache,
    worker_node_id: args.node,
    commit_sha: args.commit,
    reason: args.reason,
  };
  if (!args.node) {
    const row = await args.db
      .insertInto("environment_cache_fills")
      .values(values)
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }
  const row = await args.db
    .insertInto("environment_cache_fills")
    .values(values)
    .onConflict((conflict) =>
      conflict
        .columns([
          "project_id",
          "environment_name",
          "cache_name",
          "worker_node_id",
        ])
        .where("status", "=", "queued")
        .where("worker_node_id", "is not", null)
        // A request joins the waiting fill: the latest commit asked for,
        // and a request outranks a first use.
        .doUpdateSet((excluded) => ({
          commit_sha: excluded.ref("excluded.commit_sha"),
          reason: excluded.ref("excluded.reason"),
          queued_at: sql<Date>`now()`,
        })),
    )
    .returning("id")
    .executeTakeFirst();
  return row?.id;
}

/**
 * What a new workspace's agent is told of its caches (ADR 0334): each
 * one's commit and fill time, or that its machine has none yet.
 */
export async function cacheNote(args: {
  db: Kysely<DB>;
  allocation: ExecutionAllocation;
}): Promise<string | undefined> {
  const caches = args.allocation.policy.sandbox?.caches ?? [];
  const node = args.allocation.workerNodeId;
  if (caches.length === 0 || !node) return undefined;
  const copies = await machineCopies({
    db: args.db,
    projectId: args.allocation.projectId,
    environment: args.allocation.environmentName,
    node,
  });
  const lines = caches.map((cache) => {
    const copy = copies.get(cache.name);
    return copy
      ? `- ${cache.name} at ${cache.path}: filled from main at ${copy.commit?.slice(0, 12) ?? "its head"}${copy.filledAt ? ` on ${copy.filledAt.toISOString()}` : ""}`
      : `- ${cache.name} at ${cache.path}: not in this workspace, since this machine has no copy (none yet, or it lost one), so installs use the network; Work is filling one for later workspaces`;
  });
  return [
    `This workspace mounts its Environment's caches read only; nothing here can write them. Each holds ${CACHE_PROVENANCE_FILE}, saying which commit of main filled it and when.`,
    ...lines,
  ].join("\n");
}
