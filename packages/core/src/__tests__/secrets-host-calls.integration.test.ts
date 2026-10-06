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
import { SECRETS_CAPABILITY } from "../services/secrets-capability.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * `host["catamorphic.secrets"]` from inside a workflow (ADR 0210): a run
 * whose workflow declared `secrets:write` gives a member, named by email,
 * a value of their own; a workflow that declared nothing is refused, and
 * no call returns a value. The runtime is faked at the invocation boundary,
 * returning the transitions a real boundary would.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_secret_calls_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};
const KEY = "ch-issued-0123456789";

const WORKFLOWS = `
export const issueKey = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["secrets:write", "secrets:read"],
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ email: string; key: string }>) =>
        host["catamorphic.secrets"].set({ name: "CLICKHOUSE_API_KEY", value: input.key, member: input.email }),
    }),
    defineBoundary({
      run: ({ host }: BoundaryContext<{}>) => host["catamorphic.secrets"].list({}),
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<{ items: unknown[] }>) => input,
    }),
  ],
}));

export const sneakyKey = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ email: string; key: string }>) =>
        host["catamorphic.secrets"].set({ name: "CLICKHOUSE_API_KEY", value: input.key, member: input.email }),
    }),
  ],
}));
`;

/** What each invocation carried, for assertions. */
const seen: Array<{ exportName: string; stepIndex: number; input: unknown }> =
  [];

function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind !== "durable-boundary")
    throw new Error(`Unexpected invocation kind '${invocation.kind}'`);
  const { exportName, stepIndex } = invocation.target;
  seen.push({ exportName, stepIndex, input: invocation.input });
  const raw = invocation.input as { value?: unknown };
  const value = (raw.value ?? {}) as Record<string, unknown>;
  const call = (fn: string, args: unknown): RuntimeTerminalResult => ({
    status: "completed",
    result: {
      type: "host_call",
      transition: {
        __catamorphicDurableTransition: "host_call",
        capability: SECRETS_CAPABILITY,
        fn,
        args,
      },
    },
    steps: [],
  });
  const terminal: RuntimeTerminalResult =
    stepIndex === 0
      ? call("set", {
          name: "CLICKHOUSE_API_KEY",
          value: value.key,
          member: value.email,
        })
      : exportName === "issueKey" && stepIndex === 1
        ? call("list", {})
        : {
            status: "completed",
            result: { type: "completed", output: value },
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

describeIf("catamorphic.secrets host calls (ADR 0210)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
  /** Bob runs onboarding; he holds secrets:read and secrets:write. */
  let bob: Identity;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-secret-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const sandboxProvider = new FakeSandboxProvider();
    const members = new Map([["ada@example.test", "ada"]]);
    core = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider,
      environmentProvider: testEnvironmentProvider(sandboxProvider),
      // Ada is the project's member; nobody else outside Bob.
      resolveMemberIdentity: async ({ tenantId, projectId, externalUserId }) =>
        ["ada", "bob"].includes(externalUserId)
          ? {
              tenantId,
              externalUserId,
              scope: [{ kind: "agent", projectId, name: "*" }],
            }
          : null,
      memberIdForEmail: async ({ email }) => members.get(email) ?? null,
    });
    const project = await core.projects.create(root, { name: "onboarding" });
    projectId = project.id;
    await core.projects.writeFile(
      root,
      projectId,
      ".work/workflows/src/onboarding.ts",
      { content: WORKFLOWS, commitMessage: "Add onboarding" },
    );
    await core.projects.writeFile(root, projectId, ".work/project.json", {
      content: JSON.stringify({
        secrets: { CLICKHOUSE_API_KEY: { description: "ClickHouse key" } },
        environments: {
          default: {
            workloads: ["agent", "workflow"],
            secrets: ["CLICKHOUSE_API_KEY"],
          },
        },
      }),
      commitMessage: "Declare secrets",
    });
    const deployed = await core.deployment.deploy(
      root.tenantId,
      projectId,
      root.externalUserId,
      { message: "deploy" },
    );
    expect(deployed.status).toBe("deployed");
    bob = {
      ...root,
      externalUserId: "bob",
      executionScope: [{ projectId, name: "default" }],
      scope: [
        { kind: "workflow", projectId, name: "issueKey" },
        { kind: "workflow", projectId, name: "sneakyKey" },
      ],
      projectPermissions: [
        { projectId, permission: "secrets:read" },
        { projectId, permission: "secrets:write" },
      ],
    };
  }, 120_000);

  afterAll(async () => {
    await core.runs.stopWorkers();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("a workflow that declared secrets:write gives a member their own value", async () => {
    const outcome = await core.runs.call({
      identity: bob,
      projectId,
      workflowName: "issueKey",
      input: { email: "ada@example.test", key: KEY },
      budgetMs: 20_000,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    // `set` named Ada by her id; `list` reports her value, never it.
    const set = seen.find(
      (entry) => entry.exportName === "issueKey" && entry.stepIndex === 1,
    );
    expect((set?.input as { value: unknown } | undefined)?.value).toMatchObject(
      {
        name: "CLICKHOUSE_API_KEY",
        member: "ada",
      },
    );
    expect(outcome.output).toEqual({
      items: [
        {
          name: "CLICKHOUSE_API_KEY",
          description: "ClickHouse key",
          source: "project",
          shared: false,
          members: ["ada"],
          environments: ["default"],
        },
      ],
    });
    // What the calls returned to the run never holds the value.
    expect(JSON.stringify(set?.input)).not.toContain(KEY);
    expect(JSON.stringify(outcome.output)).not.toContain(KEY);
    // Ada's chats receive it; nobody else's.
    const forAda = await core.secrets?.resolveForSandbox({
      identity: root,
      projectId,
      environment: "default",
      owner: "ada",
    });
    expect(forAda?.variables).toEqual({ CLICKHOUSE_API_KEY: KEY });
    const forProject = await core.secrets?.resolveForSandbox({
      identity: root,
      projectId,
      environment: "default",
      owner: null,
    });
    expect(forProject?.variables).toEqual({});
  });

  it("a workflow that declared nothing is refused, and so is a stranger", async () => {
    const refused = await core.runs.call({
      identity: bob,
      projectId,
      workflowName: "sneakyKey",
      input: { email: "ada@example.test", key: "stolen-0123456789" },
      budgetMs: 20_000,
    });
    expect(refused.status).toBe("failed");
    if (refused.status === "failed")
      expect(refused.error).toMatch(
        /Host call catamorphic\.secrets\.set failed: Not authorized/,
      );
    const stranger = await core.runs.call({
      identity: bob,
      projectId,
      workflowName: "issueKey",
      input: { email: "eve@example.test", key: "eve-0123456789" },
      budgetMs: 20_000,
    });
    expect(stranger.status).toBe("failed");
    if (stranger.status === "failed")
      expect(stranger.error).toContain("eve@example.test is not a member");
    const forAda = await core.secrets?.resolveForSandbox({
      identity: root,
      projectId,
      environment: "default",
      owner: "ada",
    });
    expect(forAda?.variables).toEqual({ CLICKHOUSE_API_KEY: KEY });
  });
});
