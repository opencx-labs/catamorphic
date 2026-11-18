import type { DB } from "@catamorphic/db";
import { cacheVolumeKey, type SandboxVolume } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import type { ExecutionAllocation } from "./execution-allocations-service.js";

/** Written into each cache's root by its fill: what it holds (ADR 0334). */
export const CACHE_PROVENANCE_FILE = ".work-cache.json";

/**
 * What a sandbox an Allocation makes mounts of its Environment's caches
 * (ADR 0334): a fill's Allocation its one writable generation; any other
 * the generation its machine holds of each cache, read only. A cache the
 * machine holds none of is not mounted, and a fill for that machine is
 * queued. Called as the sandbox is made, so a fill published since the
 * Allocation was admitted is the one mounted.
 */
export async function cacheMounts(args: {
  db: Kysely<DB>;
  allocation: ExecutionAllocation;
}): Promise<SandboxVolume[]> {
  const sandbox = args.allocation.policy.sandbox;
  if (sandbox?.fill)
    return [{ key: sandbox.fill.key, path: sandbox.fill.path }];
  const caches = sandbox?.caches ?? [];
  const node = args.allocation.workerNodeId;
  if (caches.length === 0 || !node) return [];
  const copies = await machineCopies({
    db: args.db,
    projectId: args.allocation.projectId,
    environment: args.allocation.environmentName,
    node,
  });
  const mounts: SandboxVolume[] = [];
  const missing: string[] = [];
  for (const cache of caches) {
    const copy = copies.get(cache.name);
    if (!copy) {
      missing.push(cache.name);
      continue;
    }
    mounts.push({
      key: cacheVolumeKey({
        projectId: args.allocation.projectId,
        environment: args.allocation.environmentName,
        name: cache.name,
        generation: copy.generation,
      }),
      path: cache.path,
      readOnly: true,
    });
  }
  const used = caches
    .map((cache) => copies.get(cache.name)?.id)
    .filter((id): id is string => id !== undefined);
  if (used.length > 0)
    await args.db
      .updateTable("environment_cache_fills")
      .set({ last_used_at: sql<Date>`now()` })
      .where("id", "in", used)
      .execute();
  if (missing.length > 0) {
    const tenant = await args.db
      .selectFrom("execution_allocations")
      .select("tenant_id")
      .where("id", "=", args.allocation.id)
      .executeTakeFirst();
    if (tenant)
      for (const name of missing)
        await queueMachineFill({
          db: args.db,
          tenantId: tenant.tenant_id,
          projectId: args.allocation.projectId,
          environment: args.allocation.environmentName,
          cache: name,
          node,
          commit: null,
          reason: "first-use",
          onlyWhenIdle: true,
        });
  }
  return mounts;
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
      : `- ${cache.name} at ${cache.path}: this machine has no copy yet, so installs use the network; Work is filling one for later workspaces`;
  });
  return [
    `This workspace mounts its Environment's caches read only; nothing here can write them. Each holds ${CACHE_PROVENANCE_FILE}, saying which commit of main filled it and when.`,
    ...lines,
  ].join("\n");
}
