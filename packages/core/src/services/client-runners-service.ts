import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import {
  type EnvironmentRuntimeBinding,
  ExecutorPublicKeySchema,
  SANDBOX_CAPABILITIES,
  type SandboxCapability,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  type Identity,
  identityMayUseEnvironment,
  mayUseProject,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ProjectEnvironmentsService } from "./project-environments-service.js";
import {
  clientExecutor,
  RemoteExecutorLeaseLostError,
  RemoteOperationQueue,
  registerExecutorKey,
} from "./remote-operations.js";
import { toJson } from "./run-coordinator.js";

const resourceLimitsSchema = z.array(
  z.enum(["cpuMillis", "memoryMb", "storageMb", "gpu"]),
);
const isolationSchema = z.enum(["none", "process", "sandbox"]);
const capabilitiesSchema = z.array(
  z.enum([
    SANDBOX_CAPABILITIES.images,
    SANDBOX_CAPABILITIES.imageBuild,
    SANDBOX_CAPABILITIES.containers,
    SANDBOX_CAPABILITIES.egressPolicy,
  ]),
);
/** Authenticated member clients provide execution, never database access. */
export class ClientRunnersService {
  private readonly queue: RemoteOperationQueue;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly environments: ProjectEnvironmentsService,
  ) {
    this.queue = new RemoteOperationQueue(db);
  }

  async register(args: {
    identity: Identity;
    projectId: string;
    id: string;
    environment: string;
    label: string;
    workspaceRoot: string;
    resourceLimits?: ("cpuMillis" | "memoryMb" | "storageMb" | "gpu")[];
    isolation?: "none" | "process" | "sandbox";
    /** The runner's provider runs background processes (ADR 0174). */
    processes?: boolean;
    /** What its sandboxes can be given: images, image builds (ADR 0176). */
    capabilities?: readonly SandboxCapability[];
    /**
     * The runner's X25519 public key: every operation for this connection is
     * sealed to it (ADR 0206). Its private key stays on the member's machine.
     */
    publicKey: string;
  }) {
    if (
      !args.workspaceRoot.startsWith("/") ||
      args.workspaceRoot.includes("\0")
    )
      throw new Error(
        "The client workspace root must be an absolute sandbox path",
      );
    const publicKey = ExecutorPublicKeySchema.parse(args.publicKey);
    await this.authorize(args);
    const token = randomUUID();
    const resourceLimits = toJson(
      resourceLimitsSchema.parse(args.resourceLimits ?? []),
    );
    const capabilities = toJson(
      capabilitiesSchema.parse(args.capabilities ?? []),
    );
    const row = await this.db.transaction().execute(async (trx) => {
      const registered = await trx
        .insertInto("client_runners")
        .values({
          id: args.id,
          tenant_id: args.identity.tenantId,
          project_id: args.projectId,
          external_user_id: args.identity.externalUserId,
          environment_name: args.environment,
          label: args.label,
          workspace_root: args.workspaceRoot,
          resource_limits: resourceLimits,
          isolation: isolationSchema.parse(args.isolation ?? "none"),
          processes: args.processes ?? false,
          capabilities,
          lease_token: token,
          lease_expires_at: sql`now() + interval '45 seconds'`,
        })
        .onConflict((oc) =>
          oc
            .column("id")
            .doUpdateSet({
              lease_token: token,
              lease_expires_at: sql`now() + interval '45 seconds'`,
              updated_at: sql`now()`,
              label: args.label,
              workspace_root: args.workspaceRoot,
              resource_limits: resourceLimits,
              isolation: isolationSchema.parse(args.isolation ?? "none"),
              processes: args.processes ?? false,
              capabilities,
              environment_name: args.environment,
            })
            .where("client_runners.tenant_id", "=", args.identity.tenantId)
            .where("client_runners.project_id", "=", args.projectId)
            .where(
              "client_runners.external_user_id",
              "=",
              args.identity.externalUserId,
            )
            .where("client_runners.lease_expires_at", "<=", sql<Date>`now()`),
        )
        .returning("id")
        .executeTakeFirst();
      // Only the connection that took the lease brings its key.
      if (registered)
        await registerExecutorKey({
          db: trx,
          executor: clientExecutor(registered.id),
          publicKey,
        });
      return registered;
    });
    if (!row) throw new Error("This client runner is already connected");
    return { id: row.id, token };
  }

  /**
   * Take up to `max` operations for this runner, waiting up to 20 seconds.
   * A poll retried with the same `pollId` receives what it already took.
   */
  async poll(args: {
    identity: Identity;
    id: string;
    token: string;
    pollId: string;
    max?: number;
    signal?: AbortSignal;
  }) {
    await this.renew(args);
    return this.queue.poll({
      executor: clientExecutor(args.id),
      leaseToken: args.token,
      pollId: args.pollId,
      ...(args.max !== undefined ? { max: args.max } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      waitMs: 20_000,
      leaseHeld: () => this.leaseHeld({ id: args.id, token: args.token }),
    });
  }

  async complete(args: {
    identity: Identity;
    id: string;
    token: string;
    jobId: string;
    response?: unknown;
    error?: string;
  }) {
    await this.requireRunner(args);
    await this.queue.complete({
      executor: clientExecutor(args.id),
      leaseToken: args.token,
      operationId: args.jobId,
      ...(args.response !== undefined ? { response: args.response } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    });
    return { ok: true };
  }

  /** Keep the lease while operations run and no poll is pending. */
  async renew(args: { identity: Identity; id: string; token: string }) {
    await this.requireRunner(args);
    const renewed = await this.db
      .updateTable("client_runners")
      .set({
        lease_expires_at: sql`now() + interval '45 seconds'`,
        updated_at: sql`now()`,
      })
      .where("id", "=", args.id)
      .where("lease_token", "=", args.token)
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .returning("id")
      .executeTakeFirst();
    if (!renewed) throw new RemoteExecutorLeaseLostError();
  }

  async disconnect(args: { identity: Identity; id: string; token: string }) {
    try {
      await this.requireRunner(args);
    } catch (error) {
      // Already gone: nothing to end.
      if (error instanceof RemoteExecutorLeaseLostError) return;
      throw error;
    }
    await this.db
      .updateTable("client_runners")
      .set({ lease_expires_at: sql`now()` })
      .where("id", "=", args.id)
      .where("lease_token", "=", args.token)
      .execute();
  }

  async binding(args: {
    tenantId: string;
    ownerUserId?: string;
    projectId?: string;
    clientRunnerId?: string;
    allocationBindingId?: string;
  }): Promise<EnvironmentRuntimeBinding | undefined> {
    const allocationParts = args.allocationBindingId?.startsWith("client:")
      ? args.allocationBindingId.split(":")
      : undefined;
    const id = allocationParts?.[1] ?? args.clientRunnerId;
    if (!id || !args.ownerUserId || !args.projectId) return undefined;
    const runner = await this.db
      .selectFrom("client_runners")
      .selectAll()
      .where("id", "=", id)
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.ownerUserId)
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (
      !runner ||
      (allocationParts?.[2] && allocationParts[2] !== runner.lease_token)
    )
      return undefined;
    const provider = this.queue.provider({
      executor: clientExecutor(runner.id),
      leaseToken: runner.lease_token,
      leaseHeld: (token) => this.leaseHeld({ id: runner.id, token }),
      label: "This machine",
      workspaceRoot: runner.workspace_root,
      processes: runner.processes,
      attributes: {
        "catamorphic.tenant.id": args.tenantId,
        "catamorphic.project.id": args.projectId,
      },
    });
    return {
      descriptor: {
        id: `client:${runner.id}:${runner.lease_token}`,
        label: "This machine",
        trust: "local",
        isolation: isolationSchema.parse(runner.isolation),
        resourceLimits: resourceLimitsSchema.parse(runner.resource_limits),
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: [
          "network.egress",
          ...capabilitiesSchema.parse(runner.capabilities),
        ],
        resources: {},
      },
      sandboxProvider: provider,
    };
  }

  private async leaseHeld(args: { id: string; token: string }) {
    return Boolean(
      await this.db
        .selectFrom("client_runners")
        .select("id")
        .where("id", "=", args.id)
        .where("lease_token", "=", args.token)
        .where("lease_expires_at", ">", sql<Date>`now()`)
        .executeTakeFirst(),
    );
  }

  /**
   * The member's own runner, still permitted to serve its Environment. A
   * lapsed or replaced lease is a lost connection, not a refusal: the runner
   * registers again.
   */
  private async requireRunner(args: {
    identity: Identity;
    id: string;
    token: string;
  }) {
    const runner = await this.db
      .selectFrom("client_runners")
      .selectAll()
      .select(sql<boolean>`lease_expires_at > now()`.as("lease_live"))
      .where("id", "=", args.id)
      .where("tenant_id", "=", args.identity.tenantId)
      .where("external_user_id", "=", args.identity.externalUserId)
      .executeTakeFirst();
    if (!runner) throw new AccessDeniedError();
    await this.authorize({
      identity: args.identity,
      projectId: runner.project_id,
      environment: runner.environment_name,
    });
    if (runner.lease_token !== args.token || !runner.lease_live)
      throw new RemoteExecutorLeaseLostError();
    return runner;
  }
  private async authorize(args: {
    identity: Identity;
    projectId: string;
    environment: string;
  }) {
    if (
      !mayUseProject(args.identity, args.projectId) ||
      !identityMayUseEnvironment(
        args.identity,
        args.projectId,
        args.environment,
      )
    )
      throw new AccessDeniedError();
    const policy = await this.environments.list(args);
    if (policy.environments[args.environment]?.device !== "member")
      throw new AccessDeniedError();
  }
}
