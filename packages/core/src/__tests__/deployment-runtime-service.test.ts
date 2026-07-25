import { EXECUTION_TRANSFORM_VERSION } from "@catamorphic/parser";
import type {
  DeploymentRuntime,
  DeploymentRuntimeProvider,
  GetRuntimeHealthArgs,
  RuntimeHealth,
  SandboxProvider,
} from "@catamorphic/sandbox";
import {
  DEPLOYMENT_RUNTIME_VERSION,
  RUNTIME_PROTOCOL_VERSION,
} from "@catamorphic/sandbox";
import { describe, expect, it, vi } from "vitest";
import { DeploymentRuntimeService } from "../services/deployment-runtime-service.js";
import type {
  DeploymentRuntimeRecord,
  DeploymentRuntimeRecordStatus,
  DeploymentRuntimeStore,
} from "../services/deployment-runtime-store.js";

const now = new Date("2026-07-12T12:00:00.000Z");
const old = new Date("2026-06-01T00:00:00.000Z");

describe("DeploymentRuntimeService lifecycle", () => {
  it("rejects artifacts prepared by an older transform or runtime", async () => {
    const store = new FakeDeploymentRuntimeStore({ runtimes: [] });
    const provider = createProvider({
      deploymentRuntime: createRuntimeProvider({}),
    });
    const service = createService({
      store,
      provider,
      verifyArtifact: async () => false,
    });
    const artifact = {
      id: "artifact-stale",
      projectId: "project-1",
      commitSha: "a".repeat(40),
      artifactDigest: "b".repeat(64),
      pluginDigest: "c".repeat(64),
      transformVersion: "execution-transform-v2",
      runtimeVersion: "runtime-protocol-v5",
      status: "ready" as const,
      createdAt: old.toISOString(),
      readyAt: old.toISOString(),
      lastUsedAt: old.toISOString(),
    };

    await expect(
      service.ensure({
        projectId: "project-1",
        artifact,
        files: {},
        originalFiles: {},
      }),
    ).rejects.toThrow("incompatible transform or runtime versions");
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(provider.deploymentRuntime?.ensureRuntime).not.toHaveBeenCalled();
  });

  it("restarts an idle retired runtime instead of rematerializing it", async () => {
    const store = new FakeDeploymentRuntimeStore({
      runtimes: [
        runtime({
          id: "stopped",
          artifactId: "artifact-stopped",
          status: "stopped",
        }),
      ],
    });
    const deploymentRuntime = createRuntimeProvider({
      ensureRuntime: async () => ({
        runtimeId: "provider-stopped",
        sandboxId: "sandbox-stopped",
        deploymentArtifactId: "artifact-stopped",
        artifactDigest: "b".repeat(64),
        transformVersion: EXECUTION_TRANSFORM_VERSION,
        runtimeVersion: DEPLOYMENT_RUNTIME_VERSION,
        generation: "1",
        status: "healthy",
      }),
    });
    const provider = createProvider({ deploymentRuntime });
    const service = createService({ store, provider });

    await service.ensure({
      projectId: "project-1",
      artifact: {
        id: "artifact-stopped",
        projectId: "project-1",
        commitSha: "a".repeat(40),
        artifactDigest: "b".repeat(64),
        pluginDigest: "c".repeat(64),
        transformVersion: EXECUTION_TRANSFORM_VERSION,
        runtimeVersion: DEPLOYMENT_RUNTIME_VERSION,
        status: "ready",
        createdAt: old.toISOString(),
        readyAt: old.toISOString(),
        lastUsedAt: old.toISOString(),
      },
      files: {},
      originalFiles: {},
    });

    expect(provider.startSandbox).toHaveBeenCalledWith("sandbox-stopped");
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(store.get("stopped")).toMatchObject({ status: "ready" });
  });

  it("reconciles provider health and reports aggregate capacity", async () => {
    const store = new FakeDeploymentRuntimeStore({
      runtimes: [
        runtime({ id: "healthy", artifactId: "artifact-healthy" }),
        runtime({
          id: "starting",
          artifactId: "artifact-starting",
          status: "starting",
        }),
        runtime({ id: "broken", artifactId: "artifact-broken" }),
      ],
    });
    const deploymentRuntime = createRuntimeProvider({
      getHealth: async ({ runtimeId }) => {
        if (runtimeId === "provider-broken") {
          throw new Error("runtime unavailable");
        }
        return health({
          runtimeId,
          runtimeStatus:
            runtimeId === "provider-starting" ? "starting" : "healthy",
          activeInvocations: runtimeId === "provider-healthy" ? 2 : 0,
          queuedInvocations: runtimeId === "provider-healthy" ? 1 : 0,
          maxConcurrency: 4,
        });
      },
    });
    const service = createService({ store, deploymentRuntime });

    await expect(service.reconcileHealth()).resolves.toEqual({
      examined: 3,
      healthy: 1,
      starting: 1,
      stopped: 0,
      failed: 1,
      activeInvocations: 2,
      queuedInvocations: 1,
      maxConcurrency: 8,
    });
    expect(store.get("healthy")).toMatchObject({
      status: "ready",
      lastHeartbeatAt: now,
      lastUsedAt: now,
    });
    expect(store.get("starting")).toMatchObject({
      status: "starting",
      lastHeartbeatAt: now,
    });
    expect(store.get("broken")).toMatchObject({ status: "failed" });
  });

  it("retires only idle runtimes without pinned work", async () => {
    const store = new FakeDeploymentRuntimeStore({
      runtimes: [
        runtime({ id: "free", artifactId: "artifact-free" }),
        runtime({ id: "workflow", artifactId: "artifact-workflow" }),
        runtime({ id: "batch", artifactId: "artifact-batch" }),
      ],
      pinnedArtifactIds: ["artifact-workflow", "artifact-batch"],
    });
    const provider = createProvider({
      deploymentRuntime: createRuntimeProvider({}),
    });
    const service = createService({ store, provider });

    await expect(
      service.retireIdle({ idleBefore: new Date("2026-07-01T00:00:00.000Z") }),
    ).resolves.toEqual({
      examined: 3,
      retired: 1,
      skippedPinned: 2,
      failed: 0,
    });
    expect(provider.stopSandbox).toHaveBeenCalledTimes(1);
    expect(provider.stopSandbox).toHaveBeenCalledWith("sandbox-free");
    expect(store.get("free")).toMatchObject({ status: "stopped" });
    expect(store.get("workflow")).toMatchObject({ status: "ready" });
    expect(store.get("batch")).toMatchObject({ status: "ready" });
  });

  it("destroys old runtimes but preserves pinned workflow and batch work", async () => {
    const store = new FakeDeploymentRuntimeStore({
      runtimes: [
        runtime({ id: "free", artifactId: "artifact-free" }),
        runtime({ id: "workflow", artifactId: "artifact-workflow" }),
        runtime({ id: "batch", artifactId: "artifact-batch" }),
        runtime({ id: "failure", artifactId: "artifact-failure" }),
      ],
      oldRuntimeIds: ["free", "workflow", "batch", "failure"],
      pinnedArtifactIds: ["artifact-workflow", "artifact-batch"],
    });
    const provider = createProvider({
      deploymentRuntime: createRuntimeProvider({}),
      destroySandbox: async (sandboxId) => {
        if (sandboxId === "sandbox-failure") {
          throw new Error("provider cleanup failed");
        }
      },
    });
    const service = createService({ store, provider });

    await expect(
      service.cleanupOldArtifacts({
        lastUsedBefore: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      examined: 4,
      destroyed: 1,
      retiredArtifacts: 1,
      skippedPinned: 2,
      failed: 1,
    });
    expect(provider.destroySandbox).toHaveBeenCalledTimes(2);
    expect(store.get("free")).toBeNull();
    expect(store.retiredArtifactIds).toEqual(new Set(["artifact-free"]));
    expect(store.get("workflow")).toMatchObject({ status: "ready" });
    expect(store.get("batch")).toMatchObject({ status: "ready" });
    expect(store.get("failure")).toMatchObject({ status: "failed" });
  });
});

function createService(args: {
  store: DeploymentRuntimeStore;
  deploymentRuntime?: DeploymentRuntimeProvider;
  provider?: SandboxProvider;
  verifyArtifact?: () => Promise<boolean>;
}): DeploymentRuntimeService {
  return new DeploymentRuntimeService(args.store, {
    provider:
      args.provider ??
      createProvider({ deploymentRuntime: args.deploymentRuntime }),
    artifacts: {
      markStatus: vi.fn(async () => {}),
      verify: vi.fn(args.verifyArtifact ?? (async () => true)),
    },
    now: () => now,
  });
}

function createRuntimeProvider(args: {
  ensureRuntime?: () => Promise<DeploymentRuntime>;
  getHealth?: (args: GetRuntimeHealthArgs) => Promise<RuntimeHealth>;
}): DeploymentRuntimeProvider {
  return {
    ensureRuntime: vi.fn(args.ensureRuntime),
    invoke: vi.fn(),
    cancel: vi.fn(async () => {}),
    getHealth: vi.fn(
      args.getHealth ??
        (async ({ runtimeId }) =>
          health({
            runtimeId,
            runtimeStatus: "healthy",
            activeInvocations: 0,
            queuedInvocations: 0,
            maxConcurrency: 4,
          })),
    ),
  };
}

function createProvider(args: {
  deploymentRuntime?: DeploymentRuntimeProvider;
  destroySandbox?: (sandboxId: string) => Promise<void>;
}): SandboxProvider {
  return {
    workspaceRoot: "/workspace",
    deploymentRuntime: args.deploymentRuntime,
    createSandbox: vi.fn(),
    startSandbox: vi.fn(async () => {}),
    stopSandbox: vi.fn(async () => {}),
    destroySandbox: vi.fn(args.destroySandbox ?? (async () => {})),
    getSandboxStatus: vi.fn(),
    executeCommand: vi.fn(),
    uploadFiles: vi.fn(),
    downloadFile: vi.fn(),
    gitClone: vi.fn(),
    gitCheckout: vi.fn(),
  };
}

function health(args: {
  runtimeId: string;
  runtimeStatus: RuntimeHealth["runtimeStatus"];
  activeInvocations: number;
  queuedInvocations: number;
  maxConcurrency: number;
}): RuntimeHealth & {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  status: "healthy";
  activeInvocations: number;
  queuedInvocations: number;
  maxConcurrency: number;
} {
  return {
    runtimeId: args.runtimeId,
    runtimeStatus: args.runtimeStatus,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    status: "healthy",
    activeInvocations: args.activeInvocations,
    queuedInvocations: args.queuedInvocations,
    maxConcurrency: args.maxConcurrency,
  };
}

function runtime(args: {
  id: string;
  artifactId: string;
  status?: DeploymentRuntimeRecordStatus;
}): DeploymentRuntimeRecord {
  return {
    id: args.id,
    artifactId: args.artifactId,
    sandboxId: `sandbox-${args.id}`,
    providerId: `provider-${args.id}`,
    replicaIndex: 0,
    generation: 1,
    status: args.status ?? "ready",
    createdAt: old,
    lastHeartbeatAt: old,
    lastUsedAt: old,
  };
}

class FakeDeploymentRuntimeStore implements DeploymentRuntimeStore {
  readonly retiredArtifactIds = new Set<string>();
  private readonly runtimes = new Map<string, DeploymentRuntimeRecord>();
  private readonly pinnedArtifactIds: ReadonlySet<string>;
  private readonly oldRuntimeIds: ReadonlySet<string>;

  constructor(args: {
    runtimes: readonly DeploymentRuntimeRecord[];
    pinnedArtifactIds?: readonly string[];
    oldRuntimeIds?: readonly string[];
  }) {
    for (const record of args.runtimes) {
      this.runtimes.set(record.id, record);
    }
    this.pinnedArtifactIds = new Set(args.pinnedArtifactIds);
    this.oldRuntimeIds = new Set(args.oldRuntimeIds);
  }

  async withArtifactLock<Result>(args: {
    artifactId: string;
    operation: () => Promise<Result>;
  }): Promise<Result> {
    return args.operation();
  }

  get(runtimeId: string): DeploymentRuntimeRecord | null {
    return this.runtimes.get(runtimeId) ?? null;
  }

  async findReusable(args: {
    artifactId: string;
  }): Promise<DeploymentRuntimeRecord | null> {
    return (
      [...this.runtimes.values()].find(
        (record) =>
          record.artifactId === args.artifactId &&
          (record.status === "ready" ||
            record.status === "starting" ||
            record.status === "stopped"),
      ) ?? null
    );
  }

  async nextGeneration(args: {
    artifactId: string;
    replicaIndex: number;
  }): Promise<number> {
    const generations = [...this.runtimes.values()]
      .filter(
        (record) =>
          record.artifactId === args.artifactId &&
          record.replicaIndex === args.replicaIndex,
      )
      .map((record) => record.generation);
    return Math.max(0, ...generations) + 1;
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
    const id = `runtime-${this.runtimes.size}`;
    this.runtimes.set(id, {
      id,
      artifactId: args.artifactId,
      sandboxId: args.sandboxId,
      providerId: args.providerId,
      replicaIndex: args.replicaIndex,
      generation: args.generation,
      status: args.status,
      createdAt: now,
      lastHeartbeatAt: args.heartbeatAt ?? null,
      lastUsedAt: now,
    });
  }

  async update(args: {
    runtimeId: string;
    status: DeploymentRuntimeRecordStatus;
    providerId?: string;
    heartbeatAt?: Date;
    usedAt?: Date;
  }): Promise<void> {
    const record = this.runtimes.get(args.runtimeId);
    if (!record) return;
    this.runtimes.set(args.runtimeId, {
      ...record,
      status: args.status,
      providerId: args.providerId ?? record.providerId,
      lastHeartbeatAt: args.heartbeatAt ?? record.lastHeartbeatAt,
      lastUsedAt: args.usedAt ?? record.lastUsedAt,
    });
  }

  async findReadyProviderId(args: {
    artifactId: string;
  }): Promise<string | null> {
    return (
      [...this.runtimes.values()].find(
        (record) =>
          record.artifactId === args.artifactId && record.status === "ready",
      )?.providerId ?? null
    );
  }

  async listHealthCandidates(args: {
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]> {
    return [...this.runtimes.values()]
      .filter(
        (record) => record.status === "ready" || record.status === "starting",
      )
      .slice(0, args.limit);
  }

  async listIdleCandidates(args: {
    idleBefore: Date;
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]> {
    return [...this.runtimes.values()]
      .filter(
        (record) =>
          record.status === "ready" && record.lastUsedAt < args.idleBefore,
      )
      .slice(0, args.limit);
  }

  async listOldArtifactCandidates(args: {
    lastUsedBefore: Date;
    limit: number;
  }): Promise<DeploymentRuntimeRecord[]> {
    void args.lastUsedBefore;
    return [...this.runtimes.values()]
      .filter((record) => this.oldRuntimeIds.has(record.id))
      .slice(0, args.limit);
  }

  async claim(args: {
    runtimeId: string;
    expectedStatus: DeploymentRuntimeRecordStatus;
  }): Promise<boolean> {
    const record = this.runtimes.get(args.runtimeId);
    if (!record || record.status !== args.expectedStatus) return false;
    this.runtimes.set(args.runtimeId, { ...record, status: "draining" });
    return true;
  }

  async hasPinnedWork(args: { artifactId: string }): Promise<boolean> {
    return this.pinnedArtifactIds.has(args.artifactId);
  }

  async deleteClaimed(args: { runtimeId: string }): Promise<boolean> {
    const record = this.runtimes.get(args.runtimeId);
    if (record?.status !== "draining") return false;
    return this.runtimes.delete(args.runtimeId);
  }

  async retireArtifactIfUnused(args: { artifactId: string }): Promise<boolean> {
    const hasRuntime = [...this.runtimes.values()].some(
      (record) => record.artifactId === args.artifactId,
    );
    if (hasRuntime) return false;
    this.retiredArtifactIds.add(args.artifactId);
    return true;
  }
}
