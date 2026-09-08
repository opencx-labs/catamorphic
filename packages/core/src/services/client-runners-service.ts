import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  EnvironmentRuntimeBinding,
  SandboxProvider,
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
import { toJson } from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");
const resourceLimitsSchema = z.array(
  z.enum(["cpuMillis", "memoryMb", "storageMb", "gpu"]),
);
const isolationSchema = z.enum(["none", "process", "sandbox"]);
const stringMap = z.record(z.string(), z.string());
export const ClientRunnerOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    options: z.object({
      resources: z
        .object({
          cpuMillis: z.number().int().positive().optional(),
          memoryMb: z.number().int().positive().optional(),
          storageMb: z.number().int().positive().optional(),
          gpu: z.boolean().optional(),
        })
        .optional(),
      snapshotName: z.string().optional(),
      language: z.string().optional(),
      envVars: stringMap.optional(),
      autoStopInterval: z.number().optional(),
      labels: stringMap.optional(),
    }),
  }),
  z.object({
    kind: z.enum(["start", "stop", "destroy", "status"]),
    sandboxId: z.string(),
  }),
  z.object({
    kind: z.literal("execute"),
    sandboxId: z.string(),
    command: z.string(),
    options: z
      .object({
        cwd: z.string().optional(),
        timeout: z.number().optional(),
        env: stringMap.optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("upload"),
    sandboxId: z.string(),
    files: stringMap,
    basePath: z.string(),
  }),
  z.object({
    kind: z.literal("download"),
    sandboxId: z.string(),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("clone"),
    sandboxId: z.string(),
    url: z.string(),
    path: z.string(),
    options: z
      .object({
        branch: z.string().optional(),
        commitId: z.string().optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("checkout"),
    sandboxId: z.string(),
    path: z.string(),
    ref: z.string(),
  }),
]);
export type ClientRunnerOperation = z.infer<typeof ClientRunnerOperationSchema>;
const statusSchema = z.enum([
  "creating",
  "started",
  "stopped",
  "archived",
  "error",
]);
const handleSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  sandboxType: z.enum(["dev", "execution"]),
  status: statusSchema,
});

export const ClientRunnerResultSchema = z.union([
  z.null(),
  z.string(),
  handleSchema,
  z.object({ exitCode: z.number(), result: z.string() }),
]);

/** Authenticated member clients provide execution, never database access. */
export class ClientRunnersService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly environments: ProjectEnvironmentsService,
  ) {}

  async register(args: {
    identity: Identity;
    projectId: string;
    id: string;
    environment: string;
    label: string;
    workspaceRoot: string;
    resourceLimits?: ("cpuMillis" | "memoryMb" | "storageMb" | "gpu")[];
    isolation?: "none" | "process" | "sandbox";
  }) {
    if (
      !args.workspaceRoot.startsWith("/") ||
      args.workspaceRoot.includes("\0")
    )
      throw new Error(
        "The client workspace root must be an absolute sandbox path",
      );
    await this.authorize(args);
    const token = randomUUID();
    const row = await this.db
      .insertInto("client_runners")
      .values({
        id: args.id,
        tenant_id: args.identity.tenantId,
        project_id: args.projectId,
        external_user_id: args.identity.externalUserId,
        environment_name: args.environment,
        label: args.label,
        workspace_root: args.workspaceRoot,
        resource_limits: toJson(
          resourceLimitsSchema.parse(args.resourceLimits ?? []),
        ),
        isolation: isolationSchema.parse(args.isolation ?? "none"),
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
            resource_limits: toJson(
              resourceLimitsSchema.parse(args.resourceLimits ?? []),
            ),
            isolation: isolationSchema.parse(args.isolation ?? "none"),
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
    if (!row) throw new Error("This client runner is already connected");
    return { id: row.id, token };
  }

  async poll(args: { identity: Identity; id: string; token: string }) {
    const runner = await this.requireRunner(args);
    await this.authorize({
      identity: args.identity,
      projectId: runner.project_id,
      environment: runner.environment_name,
    });
    await this.db
      .updateTable("client_runners")
      .set({
        lease_expires_at: sql`now() + interval '45 seconds'`,
        updated_at: sql`now()`,
      })
      .where("id", "=", args.id)
      .where("lease_token", "=", args.token)
      .execute();
    return this.db.transaction().execute(async (trx) => {
      const job = await trx
        .selectFrom("client_runner_jobs")
        .selectAll()
        .where("runner_id", "=", args.id)
        .where("lease_token", "=", args.token)
        .where("status", "=", "pending")
        .where("expires_at", ">", sql<Date>`now()`)
        .orderBy("created_at")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!job) return null;
      await trx
        .updateTable("client_runner_jobs")
        .set({ status: "running" })
        .where("id", "=", job.id)
        .execute();
      return {
        id: job.id,
        operation: ClientRunnerOperationSchema.parse(job.operation),
      };
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
    const runner = await this.requireRunner(args);
    await this.authorize({
      identity: args.identity,
      projectId: runner.project_id,
      environment: runner.environment_name,
    });
    const result = await this.db
      .updateTable("client_runner_jobs")
      .set({
        status: args.error ? "failed" : "completed",
        response: toJson(args.response ?? null),
        error: args.error ?? null,
      })
      .where("id", "=", args.jobId)
      .where("runner_id", "=", args.id)
      .where("lease_token", "=", args.token)
      .where("status", "=", "running")
      .where("expires_at", ">", sql<Date>`now()`)
      .returning("id")
      .executeTakeFirst();
    if (!result) {
      const receipt = await this.db
        .selectFrom("client_runner_jobs")
        .select("id")
        .where("id", "=", args.jobId)
        .where("runner_id", "=", args.id)
        .where("lease_token", "=", args.token)
        .where("status", "=", args.error ? "failed" : "completed")
        .where(
          sql<boolean>`response = ${JSON.stringify(args.response ?? null)}::jsonb`,
        )
        .where("error", args.error ? "=" : "is", args.error ?? null)
        .executeTakeFirst();
      if (receipt) return { ok: true };
      throw new Error(
        "Execution receipt is no longer accepted; inspect the session before retrying",
      );
    }
    return { ok: true };
  }

  async renew(args: { identity: Identity; id: string; token: string }) {
    const runner = await this.requireRunner(args);
    await this.authorize({
      identity: args.identity,
      projectId: runner.project_id,
      environment: runner.environment_name,
    });
    await this.db
      .updateTable("client_runners")
      .set({
        lease_expires_at: sql`now() + interval '45 seconds'`,
        updated_at: sql`now()`,
      })
      .where("id", "=", args.id)
      .where("lease_token", "=", args.token)
      .execute();
  }

  async disconnect(args: { identity: Identity; id: string; token: string }) {
    await this.requireRunner(args);
    await this.db
      .updateTable("client_runners")
      .set({ lease_expires_at: sql`now()` })
      .where("id", "=", args.id)
      .where("lease_token", "=", args.token)
      .execute();
  }

  async binding(args: {
    tenantId: string;
    externalUserId?: string;
    projectId?: string;
    clientRunnerId?: string;
    allocationBindingId?: string;
    workerNodeId?: string;
  }): Promise<EnvironmentRuntimeBinding | undefined> {
    const allocationParts = args.allocationBindingId?.startsWith("client:")
      ? args.allocationBindingId.split(":")
      : undefined;
    const id = allocationParts?.[1] ?? args.clientRunnerId;
    if (!id || !args.externalUserId || !args.projectId) return undefined;
    const runner = await this.db
      .selectFrom("client_runners")
      .selectAll()
      .where("id", "=", id)
      .where("tenant_id", "=", args.tenantId)
      .where("project_id", "=", args.projectId)
      .where("external_user_id", "=", args.externalUserId)
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (
      !runner ||
      (allocationParts?.[2] && allocationParts[2] !== runner.lease_token)
    )
      return undefined;
    const call = async (operation: ClientRunnerOperation): Promise<unknown> =>
      withSpan(
        {
          tracer,
          name: "client.execute",
          attributes: {
            "catamorphic.tenant.id": args.tenantId,
            "catamorphic.project.id": args.projectId,
            "catamorphic.client.id": runner.id,
            "catamorphic.client.operation": operation.kind,
          },
        },
        async () => {
          const row = await this.db
            .insertInto("client_runner_jobs")
            .values({
              runner_id: runner.id,
              lease_token: runner.lease_token,
              operation: toJson(operation),
              expires_at: sql`now() + interval '5 minutes'`,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          const deadline = Date.now() + 300000;
          while (Date.now() < deadline) {
            const job = await this.db
              .selectFrom("client_runner_jobs")
              .selectAll()
              .where("id", "=", row.id)
              .executeTakeFirstOrThrow();
            if (job.status === "completed") return job.response;
            if (job.status === "failed")
              throw new Error(job.error ?? "Client execution failed");
            const online = await this.db
              .selectFrom("client_runners")
              .select("id")
              .where("id", "=", runner.id)
              .where("lease_token", "=", runner.lease_token)
              .where("lease_expires_at", ">", sql<Date>`now()`)
              .executeTakeFirst();
            if (!online) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await this.db
            .updateTable("client_runner_jobs")
            .set({
              status: "failed",
              error:
                "Client disconnected or timed out; execution outcome may be unknown",
            })
            .where("id", "=", row.id)
            .where("status", "in", ["pending", "running"])
            .execute();
          throw new Error(
            "This machine disconnected or timed out. Check the last action before retrying.",
          );
        },
      );
    const provider: SandboxProvider = {
      workspaceRoot: runner.workspace_root,
      createSandbox: async (options) =>
        handleSchema.parse(await call({ kind: "create", options })),
      startSandbox: async (sandboxId) => {
        await call({ kind: "start", sandboxId });
      },
      stopSandbox: async (sandboxId) => {
        await call({ kind: "stop", sandboxId });
      },
      destroySandbox: async (sandboxId) => {
        await call({ kind: "destroy", sandboxId });
      },
      getSandboxStatus: async (sandboxId) =>
        statusSchema.parse(await call({ kind: "status", sandboxId })),
      executeCommand: async (sandboxId, command, options) =>
        z
          .object({ exitCode: z.number(), result: z.string() })
          .parse(await call({ kind: "execute", sandboxId, command, options })),
      uploadFiles: async (sandboxId, files, basePath) => {
        await call({ kind: "upload", sandboxId, files, basePath });
      },
      downloadFile: async (sandboxId, path) =>
        z.string().parse(await call({ kind: "download", sandboxId, path })),
      gitClone: async (sandboxId, url, path, options) => {
        await call({ kind: "clone", sandboxId, url, path, options });
      },
      gitCheckout: async (sandboxId, path, ref) => {
        await call({ kind: "checkout", sandboxId, path, ref });
      },
    };
    return {
      descriptor: {
        id: `client:${runner.id}:${runner.lease_token}`,
        label: "This machine",
        trust: "local",
        isolation: isolationSchema.parse(runner.isolation),
        resourceLimits: resourceLimitsSchema.parse(runner.resource_limits),
        workloads: ["agent"],
        agentTopologies: ["controller"],
        capabilities: ["network.egress"],
        resources: {},
      },
      workerNodeId: args.workerNodeId,
      sandboxProvider: provider,
    };
  }

  private async requireRunner(args: {
    identity: Identity;
    id: string;
    token: string;
  }) {
    const runner = await this.db
      .selectFrom("client_runners")
      .selectAll()
      .where("id", "=", args.id)
      .where("tenant_id", "=", args.identity.tenantId)
      .where("external_user_id", "=", args.identity.externalUserId)
      .where("lease_token", "=", args.token)
      .where("lease_expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!runner) throw new AccessDeniedError();
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
    if (policy.environments[args.environment]?.binding !== "this-machine")
      throw new AccessDeniedError();
  }
}
