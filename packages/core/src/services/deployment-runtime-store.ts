import type { DB } from "@catamorphic/db";
import type { Kysely, Selectable } from "kysely";

type DeploymentRuntimeRow = Selectable<DB["deployment_runtimes"]>;
const artifactLocks = new Map<string, Promise<void>>();

export type DeploymentRuntimeRecordStatus =
  | "creating"
  | "starting"
  | "ready"
  | "draining"
  | "stopped"
  | "failed";

export interface DeploymentRuntimeRecord {
  id: string;
  artifactId: string;
  sandboxId: string;
  providerId: string;
  replicaIndex: number;
  generation: number;
  status: DeploymentRuntimeRecordStatus;
  createdAt: Date;
  lastHeartbeatAt: Date | null;
  lastUsedAt: Date;
}

export interface DeploymentRuntimeStore {
  withArtifactLock<Result>(args: {
    artifactId: string;
    operation: () => Promise<Result>;
  }): Promise<Result>;
  findReusable(args: {
    artifactId: string;
  }): Promise<DeploymentRuntimeRecord | null>;
  nextGeneration(args: {
    artifactId: string;
    replicaIndex: number;
  }): Promise<number>;
  insert(args: {
    artifactId: string;
    sandboxId: string;
    providerId: string;
    replicaIndex: number;
    generation: number;
    status: DeploymentRuntimeRecordStatus;
    heartbeatAt?: Date;
  }): Promise<void>;
  update(args: {
    runtimeId: string;
    status: DeploymentRuntimeRecordStatus;
    providerId?: string;
    heartbeatAt?: Date;
    usedAt?: Date;
  }): Promise<void>;
  findReadyProviderId(args: { artifactId: string }): Promise<string | null>;
  listHealthCandidates(args: {
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]>;
  listIdleCandidates(args: {
    idleBefore: Date;
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]>;
  listOldArtifactCandidates(args: {
    lastUsedBefore: Date;
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]>;
  claim(args: {
    runtimeId: string;
    expectedStatus: DeploymentRuntimeRecordStatus;
  }): Promise<boolean>;
  hasPinnedWork(args: { artifactId: string }): Promise<boolean>;
  deleteClaimed(args: { runtimeId: string }): Promise<boolean>;
  retireArtifactIfUnused(args: { artifactId: string }): Promise<boolean>;
}

export class KyselyDeploymentRuntimeStore implements DeploymentRuntimeStore {
  constructor(private readonly db: Kysely<DB>) {}

  async withArtifactLock<Result>(args: {
    artifactId: string;
    operation: () => Promise<Result>;
  }): Promise<Result> {
    const previous = artifactLocks.get(args.artifactId) ?? Promise.resolve();
    const operation = previous.then(args.operation);
    const queued = operation.then(
      () => undefined,
      () => undefined,
    );
    artifactLocks.set(args.artifactId, queued);
    try {
      return await operation;
    } finally {
      if (artifactLocks.get(args.artifactId) === queued) {
        artifactLocks.delete(args.artifactId);
      }
    }
  }

  async findReusable(args: {
    artifactId: string;
  }): Promise<DeploymentRuntimeRecord | null> {
    const row = await this.db
      .selectFrom("deployment_runtimes")
      .where("artifact_id", "=", args.artifactId)
      .where("replica_index", "=", 0)
      .where("status", "in", ["creating", "starting", "ready", "stopped"])
      .selectAll()
      .orderBy("generation", "desc")
      .executeTakeFirst();
    return row ? mapRuntime(row) : null;
  }

  async nextGeneration(args: {
    artifactId: string;
    replicaIndex: number;
  }): Promise<number> {
    const row = await this.db
      .selectFrom("deployment_runtimes")
      .where("artifact_id", "=", args.artifactId)
      .where("replica_index", "=", args.replicaIndex)
      .select((eb) => eb.fn.max<number>("generation").as("generation"))
      .executeTakeFirst();
    return Number(row?.generation ?? 0) + 1;
  }

  async insert(args: {
    artifactId: string;
    sandboxId: string;
    providerId: string;
    replicaIndex: number;
    generation: number;
    status: DeploymentRuntimeRecordStatus;
    heartbeatAt?: Date;
  }): Promise<void> {
    await this.db
      .insertInto("deployment_runtimes")
      .values({
        artifact_id: args.artifactId,
        sandbox_id: args.sandboxId,
        provider_id: args.providerId,
        replica_index: args.replicaIndex,
        generation: args.generation,
        status: args.status,
        last_heartbeat_at: args.heartbeatAt,
      })
      .execute();
  }

  async update(args: {
    runtimeId: string;
    status: DeploymentRuntimeRecordStatus;
    providerId?: string;
    heartbeatAt?: Date;
    usedAt?: Date;
  }): Promise<void> {
    await this.db
      .updateTable("deployment_runtimes")
      .set({
        status: args.status,
        provider_id: args.providerId,
        last_heartbeat_at: args.heartbeatAt,
        last_used_at: args.usedAt,
      })
      .where("id", "=", args.runtimeId)
      .execute();
  }

  async findReadyProviderId(args: {
    artifactId: string;
  }): Promise<string | null> {
    const row = await this.db
      .selectFrom("deployment_runtimes")
      .where("artifact_id", "=", args.artifactId)
      .where("status", "=", "ready")
      .select("provider_id")
      .orderBy("generation", "desc")
      .executeTakeFirst();
    return row?.provider_id ?? null;
  }

  async listHealthCandidates(args: {
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]> {
    const rows = await this.db
      .selectFrom("deployment_runtimes")
      .where("status", "in", ["starting", "ready"])
      .selectAll()
      .orderBy("last_heartbeat_at", "asc")
      .limit(args.limit)
      .execute();
    return rows.map(mapRuntime);
  }

  async listIdleCandidates(args: {
    idleBefore: Date;
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]> {
    const rows = await this.db
      .selectFrom("deployment_runtimes")
      .where("status", "=", "ready")
      .where("last_used_at", "<", args.idleBefore)
      .selectAll()
      .orderBy("last_used_at", "asc")
      .limit(args.limit)
      .execute();
    return rows.map(mapRuntime);
  }

  async listOldArtifactCandidates(args: {
    lastUsedBefore: Date;
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]> {
    const rows = await this.db
      .selectFrom("deployment_runtimes")
      .innerJoin(
        "deployment_artifacts",
        "deployment_artifacts.id",
        "deployment_runtimes.artifact_id",
      )
      .where("deployment_artifacts.last_used_at", "<", args.lastUsedBefore)
      .where("deployment_runtimes.status", "in", ["ready", "stopped", "failed"])
      .selectAll("deployment_runtimes")
      .orderBy("deployment_artifacts.last_used_at", "asc")
      .limit(args.limit)
      .execute();
    return rows.map(mapRuntime);
  }

  async claim(args: {
    runtimeId: string;
    expectedStatus: DeploymentRuntimeRecordStatus;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("deployment_runtimes")
      .set({ status: "draining" })
      .where("id", "=", args.runtimeId)
      .where("status", "=", args.expectedStatus)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async hasPinnedWork(args: { artifactId: string }): Promise<boolean> {
    const workflowRun = await this.db
      .selectFrom("workflow_runs")
      .where("deployment_artifact_id", "=", args.artifactId)
      .where("status", "in", [
        "pending",
        "running",
        "waiting",
        "paused",
        "canceling",
      ])
      .select("id")
      .executeTakeFirst();
    return Boolean(workflowRun);
  }

  async deleteClaimed(args: { runtimeId: string }): Promise<boolean> {
    const result = await this.db
      .deleteFrom("deployment_runtimes")
      .where("id", "=", args.runtimeId)
      .where("status", "=", "draining")
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async retireArtifactIfUnused(args: { artifactId: string }): Promise<boolean> {
    const runtime = await this.db
      .selectFrom("deployment_runtimes")
      .where("artifact_id", "=", args.artifactId)
      .select("id")
      .executeTakeFirst();
    if (runtime) return false;

    const result = await this.db
      .updateTable("deployment_artifacts")
      .set({ status: "retired" })
      .where("id", "=", args.artifactId)
      .where("status", "!=", "retired")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}

function mapRuntime(row: DeploymentRuntimeRow): DeploymentRuntimeRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    sandboxId: row.sandbox_id,
    providerId: row.provider_id,
    replicaIndex: row.replica_index,
    generation: row.generation,
    status: parseStatus(row.status),
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastUsedAt: row.last_used_at,
  };
}

function parseStatus(value: string): DeploymentRuntimeRecordStatus {
  if (
    value === "creating" ||
    value === "starting" ||
    value === "ready" ||
    value === "draining" ||
    value === "stopped" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error(`Unknown deployment runtime status: ${value}`);
}
