import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type {
  DeploymentRuntimeProvider,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
  RuntimeTerminalResult,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import {
  TriggerBindingsInvalidError,
  TriggerKindNotRegisteredError,
  TriggerPayloadInvalidError,
} from "../services/triggers-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_trg_${crypto.randomUUID().replaceAll("-", "")}`;

const identity: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "alice",
};

const ticketCreated: TriggerKindRuntime = {
  name: "ticket.created",
  description: "A ticket was created",
  display: { label: "Ticket Created", icon: "bell", color: "#ca8a04" },
  payloadJsonSchema: {
    type: "object",
    properties: { ticketId: { type: "string" } },
    required: ["ticketId"],
  },
  configJsonSchema: {
    type: "object",
    properties: { onlyPriority: { type: "string" } },
  },
  validatePayload: (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { ticketId?: unknown }).ticketId === "string"
      ? { ok: true }
      : { ok: false, errors: ["ticketId: expected a string"] },
  validateConfig: (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ok: true }
      : { ok: false, errors: ["config must be an object"] },
  correlationKey: (payload) =>
    (payload as { ticketId?: string }).ticketId ?? undefined,
};

const TRIGGERED_WORKFLOWS = `
export const escalateTicket = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created", { onlyPriority: "high" })],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ ticketId: string }>) => ({
        escalated: input.ticketId,
      }),
    }),
  ],
}));

export const awaitApproval = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created")],
  steps: [
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<{ ticketId: string }>) =>
        pause<{ approved: boolean }, { ticketId: string }>({
          state: { ticketId: input.ticketId },
        }),
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<{
        reason: "resumed";
        value: { approved: boolean };
        state: { ticketId: string };
      }>) => input.value,
    }),
  ],
}));

export const flakyTicket = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created")],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ ticketId: string }>) => ({
        ok: input.ticketId,
      }),
    }),
  ],
}));
`;

function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind !== "durable-boundary") {
    throw new Error(`Unexpected invocation kind '${invocation.kind}'`);
  }
  const { exportName, stepIndex } = invocation.target;
  const input =
    typeof invocation.input === "object" && invocation.input !== null
      ? ((invocation.input as { value?: unknown }).value ?? {})
      : {};
  const ticketId = (input as { ticketId?: string }).ticketId ?? "unknown";
  if (exportName === "flakyTicket") {
    throw new Error("simulated runtime outage");
  }
  const terminal: RuntimeTerminalResult =
    exportName === "awaitApproval" && stepIndex === 0
      ? {
          status: "completed",
          result: {
            type: "pause",
            transition: {
              __catamorphicDurableTransition: "pause",
              statePresent: true,
              state: { ticketId },
            },
          },
          steps: [],
        }
      : {
          status: "completed",
          result: { type: "completed", output: { escalated: ticketId } },
          steps: [],
        };
  return Promise.resolve({
    runtimeId: invocation.runtimeId,
    invocationId: invocation.invocationId,
    events: [],
    terminal,
  });
}

class FakeSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";

  readonly deploymentRuntime: DeploymentRuntimeProvider = {
    ensureRuntime: async (args) => ({
      runtimeId: "fake-runtime",
      sandboxId: args.sandboxId,
      deploymentArtifactId: args.deploymentArtifactId,
      artifactDigest: args.artifactDigest,
      transformVersion: args.transformVersion,
      runtimeVersion: args.runtimeVersion,
      generation: "1",
      status: "healthy",
    }),
    invoke: (args) => invokeRuntime(args),
    cancel: async () => {},
    getHealth: async ({ runtimeId }) => ({
      runtimeId,
      runtimeStatus: "healthy",
      protocolVersion: 8,
      status: "healthy",
      activeInvocations: 0,
      queuedInvocations: 0,
      maxConcurrency: 8,
    }),
  };

  async createSandbox() {
    return {
      id: crypto.randomUUID(),
      providerId: `fake-sandbox-${crypto.randomUUID()}`,
      sandboxType: "execution" as const,
      status: "started" as const,
    };
  }

  async startSandbox(): Promise<void> {}
  async stopSandbox(): Promise<void> {}
  async destroySandbox(): Promise<void> {}
  async getSandboxStatus() {
    return "started" as const;
  }

  async executeCommand() {
    return { exitCode: 0, result: "" };
  }

  async uploadFiles(): Promise<void> {}
  async downloadFile(): Promise<string> {
    return "";
  }
  async gitClone(): Promise<void> {}
  async gitCheckout(): Promise<void> {}
}

describeIf("TriggersService end to end", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-triggers-"));
    const devDir = path.join(tmpDir, "dev");
    const originDir = path.join(tmpDir, "origin");
    await fs.mkdir(devDir, { recursive: true });
    await fs.mkdir(originDir, { recursive: true });
    const projectManager = new ProjectManager(
      new FsBackend(devDir),
      new FsRemoteBackend(originDir),
    );
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const sandboxProvider = new FakeSandboxProvider();
    core = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider,
      environmentProvider: testEnvironmentProvider(sandboxProvider),
      triggerKinds: [ticketCreated],
    });

    const project = await core.projects.create(identity, {
      name: "triggers-e2e",
    });
    projectId = project.id;
    await core.projects.writeFile(
      identity,
      projectId,
      "workflows/src/tickets.ts",
      {
        content: TRIGGERED_WORKFLOWS,
        commitMessage: "Add triggered workflows",
      },
    );
    const deployed = await core.deployment.deploy(
      identity.tenantId,
      projectId,
      identity.externalUserId,
      { message: "deploy triggered workflows" },
    );
    expect(deployed.status).toBe("deployed");
  }, 120_000);

  afterAll(async () => {
    await core.runs.stopWorkers();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists bindings frozen from the production commit", async () => {
    const bindings = await core.triggers.list({ identity, projectId });
    expect(bindings).toHaveLength(3);
    const escalate = bindings.find(
      (binding) => binding.workflowName === "escalateTicket",
    );
    expect(escalate).toMatchObject({
      kind: "ticket.created",
      config: { onlyPriority: "high" },
      canSuspend: false,
    });
    expect(escalate?.inputParameters[0]?.name).toBe("ticketId");
    expect(
      bindings.find((binding) => binding.workflowName === "awaitApproval")
        ?.canSuspend,
    ).toBe(true);

    // The scan is recorded, so later lists and fires read the table.
    const scans = await db
      .selectFrom("trigger_binding_scans")
      .selectAll()
      .where("project_id", "=", projectId)
      .execute();
    expect(scans).toHaveLength(1);
  });

  it("filters by kind and rejects unregistered kinds", async () => {
    const bindings = await core.triggers.list({
      identity,
      projectId,
      kind: "ticket.created",
    });
    expect(bindings).toHaveLength(3);
    await expect(
      core.triggers.list({ identity, projectId, kind: "nope" }),
    ).rejects.toBeInstanceOf(TriggerKindNotRegisteredError);
  });

  it("rejects invalid payloads before creating any run", async () => {
    await expect(
      core.triggers.fire({
        identity,
        projectId,
        kind: "ticket.created",
        payload: { wrong: true },
      }),
    ).rejects.toBeInstanceOf(TriggerPayloadInvalidError);
  });

  it("fires async: enrolls runs with the payload as input and a derived correlation key", async () => {
    const result = await core.triggers.fire({
      identity,
      projectId,
      kind: "ticket.created",
      payload: { ticketId: "T-100" },
      mode: "async",
      workflows: ["escalateTicket"],
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      workflowName: "escalateTicket",
      status: "started",
    });
    const runId = result.runs[0]?.runId ?? "";
    const run = await core.runs.get({ identity, runId });
    expect(run.input).toEqual({ ticketId: "T-100" });
    expect(run.correlationKey).toBe("T-100");

    // Redelivery with the same correlation key is a no-op (default ignore).
    const again = await core.triggers.fire({
      identity,
      projectId,
      kind: "ticket.created",
      payload: { ticketId: "T-100" },
      workflows: ["escalateTicket"],
    });
    expect(again.runs[0]?.runId).toBe(runId);
  });

  it("fires sync: completes a non-suspending workflow inline", async () => {
    const result = await core.triggers.fire({
      identity,
      projectId,
      kind: "ticket.created",
      payload: { ticketId: "T-200" },
      mode: "sync",
      workflows: ["escalateTicket"],
      budgetMs: 20_000,
    });
    expect(result.runs[0]).toMatchObject({
      workflowName: "escalateTicket",
      status: "completed",
      output: { escalated: "T-200" },
    });
    const run = await core.runs.get({
      identity,
      runId: result.runs[0]?.runId ?? "",
    });
    expect(run.status).toBe("completed");
  }, 30_000);

  it("fires sync: detaches with an honest outcome at the first pause", async () => {
    const result = await core.triggers.fire({
      identity,
      projectId,
      kind: "ticket.created",
      payload: { ticketId: "T-300" },
      mode: "sync",
      workflows: ["awaitApproval"],
      budgetMs: 20_000,
    });
    const outcome = result.runs[0];
    expect(outcome?.status).toBe("suspended");
    if (outcome?.status === "suspended") {
      expect(outcome.suspendedOn).toBe("pause");
    }
    // The run is parked durably, resumable through the normal pause surface.
    const run = await core.runs.get({
      identity,
      runId: outcome?.runId ?? "",
    });
    expect(run.status).toBe("waiting");
    expect(run.activePause).not.toBeNull();
  }, 30_000);

  it("fires sync: a failing boundary detaches on retry backoff, leaving the queue in charge", async () => {
    const result = await core.triggers.fire({
      identity,
      projectId,
      kind: "ticket.created",
      payload: { ticketId: "T-400" },
      mode: "sync",
      workflows: ["flakyTicket"],
      budgetMs: 20_000,
    });
    const outcome = result.runs[0];
    expect(outcome?.status).toBe("suspended");
    if (outcome?.status === "suspended") {
      expect(outcome.suspendedOn).toBe("backoff");
    }
    // The inline attempt burned a queue attempt; the job stays pending for
    // the polling workers to continue asynchronously.
    const jobs = await db
      .selectFrom("execution_jobs")
      .selectAll()
      .where("workflow_run_id", "=", outcome?.runId ?? "")
      .execute();
    expect(jobs[0]?.status).toBe("pending");
    expect(jobs[0]?.attempt).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("runs.call: settles a non-suspending workflow inline for a builder", async () => {
    const outcome = await core.runs.call({
      identity,
      projectId,
      workflowName: "escalateTicket",
      input: { ticketId: "T-500" },
      budgetMs: 20_000,
    });
    expect(outcome).toMatchObject({
      status: "completed",
      output: { escalated: "T-500" },
    });
    const run = await core.runs.get({ identity, runId: outcome.runId });
    expect(run.status).toBe("completed");
  }, 30_000);

  it("runs.call: a workflow-scoped viewer may call exactly its workflow", async () => {
    const viewer = {
      ...identity,
      externalUserId: "viewer",
      executionScope: [{ projectId, name: "local" }],
      scope: [{ kind: "workflow" as const, projectId, name: "escalateTicket" }],
    };
    const outcome = await core.runs.call({
      identity: viewer,
      projectId,
      workflowName: "escalateTicket",
      input: { ticketId: "T-501" },
      budgetMs: 20_000,
    });
    expect(outcome.status).toBe("completed");
    // The viewer can read the run it started, and nothing else.
    const run = await core.runs.get({ identity: viewer, runId: outcome.runId });
    expect(run.status).toBe("completed");
    await expect(
      core.runs.call({
        identity: viewer,
        projectId,
        workflowName: "awaitApproval",
        input: { ticketId: "T-502" },
      }),
    ).rejects.toThrow(AccessDeniedError);
  }, 30_000);

  it("runs.call: hands back the run at the first durable wait", async () => {
    const outcome = await core.runs.call({
      identity,
      projectId,
      workflowName: "awaitApproval",
      input: { ticketId: "T-503" },
      budgetMs: 20_000,
    });
    expect(outcome).toMatchObject({
      status: "suspended",
      suspendedOn: "pause",
    });
    const run = await core.runs.get({ identity, runId: outcome.runId });
    expect(run.status).toBe("waiting");
  }, 30_000);

  it("fans out one fire across every bound workflow", async () => {
    const result = await core.triggers.fire({
      identity,
      projectId,
      kind: "ticket.created",
      payload: { ticketId: "T-500" },
      mode: "async",
    });
    expect(result.runs.map((run) => run.workflowName).sort()).toEqual([
      "awaitApproval",
      "escalateTicket",
      "flakyTicket",
    ]);
  });

  it("fails closed when a commit binds an unknown kind", async () => {
    const project = await core.projects.create(identity, {
      name: "bad-bindings",
    });
    await core.projects.writeFile(
      identity,
      project.id,
      "workflows/src/bad.ts",
      {
        content: `
export const bad = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("not.registered")],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ id: string }>) => ({ ok: true }),
    }),
  ],
}));
`,
        commitMessage: "bad binding",
      },
    );
    await core.deployment.deploy(
      identity.tenantId,
      project.id,
      identity.externalUserId,
      { message: "deploy bad binding" },
    );
    await expect(
      core.triggers.list({ identity, projectId: project.id }),
    ).rejects.toBeInstanceOf(TriggerBindingsInvalidError);
  });

  it("treats an undeployed project as having no bindings", async () => {
    const project = await core.projects.create(identity, {
      name: "undeployed",
    });
    const bindings = await core.triggers.list({
      identity,
      projectId: project.id,
    });
    expect(bindings).toEqual([]);
  });
});
