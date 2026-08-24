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
import { DOCUMENTS_CAPABILITY } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0055: `context.caller`, `context.documents` and `context.host.*` from
 * inside a workflow. The runtime is faked at the invocation boundary — it
 * returns the transitions a real boundary would — so this pins core's side:
 * the caller stamped on the run rides into the invocation, host calls run
 * as that caller, and their results feed the next step.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_hostcalls_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

const WORKFLOWS = `
export const briefCustomer = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, documents }: BoundaryContext<{ customer: string }>) =>
        documents.read({ path: "store/customers/" + input.customer + "/notes.md" }),
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<{ path: string; text?: string }>) => ({
        summary: (input.text ?? "").slice(0, 40),
      }),
    }),
  ],
}));

export const lookupAccount = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ id: string }>) =>
        host.acme.crm.lookupAccount({ id: input.id }),
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<{ name: string; seenBy: string }>) => input,
    }),
  ],
}));

export const whoAmI = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ caller }: BoundaryContext<{}>) => ({ caller: caller ?? null }),
    }),
  ],
}));
`;

/** What each invocation carried, by workflow + step, for assertions. */
const seen: Array<{ exportName: string; stepIndex: number; input: unknown }> =
  [];

function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind !== "durable-boundary") {
    throw new Error(`Unexpected invocation kind '${invocation.kind}'`);
  }
  const { exportName, stepIndex } = invocation.target;
  seen.push({ exportName, stepIndex, input: invocation.input });
  const raw = invocation.input as { value?: unknown; caller?: unknown };
  const value = (raw.value ?? {}) as Record<string, unknown>;
  let terminal: RuntimeTerminalResult;
  if (exportName === "briefCustomer" && stepIndex === 0) {
    terminal = {
      status: "completed",
      result: {
        type: "host_call",
        transition: {
          __catamorphicDurableTransition: "host_call",
          capability: DOCUMENTS_CAPABILITY,
          fn: "read",
          args: { path: `store/customers/${String(value.customer)}/notes.md` },
        },
      },
      steps: [],
    };
  } else if (exportName === "briefCustomer") {
    terminal = {
      status: "completed",
      result: {
        type: "completed",
        output: {
          summary: String((value as { text?: string }).text ?? "").slice(0, 40),
        },
      },
      steps: [],
    };
  } else if (exportName === "lookupAccount" && stepIndex === 0) {
    terminal = {
      status: "completed",
      result: {
        type: "host_call",
        transition: {
          __catamorphicDurableTransition: "host_call",
          capability: "acme.crm",
          fn: "lookupAccount",
          args: { id: value.id },
        },
      },
      steps: [],
    };
  } else if (exportName === "lookupAccount") {
    terminal = {
      status: "completed",
      result: { type: "completed", output: value },
      steps: [],
    };
  } else {
    terminal = {
      status: "completed",
      result: { type: "completed", output: { caller: raw.caller ?? null } },
      steps: [],
    };
  }
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

describeIf("host calls from workflows (ADR 0055)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
  const crmCalls: Array<{ caller: Identity; args: unknown }> = [];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-hostcalls-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const sandboxProvider = new FakeSandboxProvider();
    core = new CatamorphicCore({
      db,
      projectManager,
      sandboxProvider,
      environmentProvider: testEnvironmentProvider(sandboxProvider),
      capabilityProviders: [
        {
          name: "acme.crm",
          calls: {
            lookupAccount: (context, args) => {
              crmCalls.push({ caller: context.caller, args });
              return {
                name: `Account ${String((args as { id: string }).id)}`,
                seenBy: context.caller.externalUserId,
              };
            },
          },
        },
      ],
    });
    const project = await core.projects.create(root, { name: "brain" });
    projectId = project.id;
    await core.projects.writeFile(root, projectId, "workflows/src/brain.ts", {
      content: WORKFLOWS,
      commitMessage: "Add workflows",
    });
    const deployed = await core.deployment.deploy(
      root.tenantId,
      projectId,
      root.externalUserId,
      { message: "deploy" },
    );
    expect(deployed.status).toBe("deployed");
    // A customer note only Alice's scope covers.
    await core.documents.write({
      identity: root,
      projectId,
      path: "store/customers/acme/notes.md",
      content: "Acme wants faster refunds and a Q4 renewal call.",
    });
  }, 120_000);

  afterAll(async () => {
    await core.runs.stopWorkers();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("the caller rides into every invocation, and a workflow can read it", async () => {
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      executionScope: [{ projectId, name: "local" }],
      scope: [
        { kind: "workflow", projectId, name: "whoAmI" },
        { kind: "document", projectId, path: "store/customers/acme/**" },
      ],
    };
    const outcome = await core.runs.call({
      identity: alice,
      projectId,
      workflowName: "whoAmI",
      input: {},
      budgetMs: 20_000,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.output).toEqual({
      caller: {
        externalUserId: "alice",
        scope: alice.scope,
      },
    });
    // The host started it as root → no caller narrowing.
    const asRoot = await core.runs.call({
      identity: root,
      projectId,
      workflowName: "whoAmI",
      input: {},
      budgetMs: 20_000,
    });
    if (asRoot.status !== "completed") throw new Error(asRoot.status);
    expect(asRoot.output).toEqual({ caller: { externalUserId: "root" } });
  });

  it("context.documents runs as the caller: a covered path reads, an uncovered one fails the step", async () => {
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      executionScope: [{ projectId, name: "local" }],
      scope: [
        { kind: "workflow", projectId, name: "briefCustomer" },
        { kind: "document", projectId, path: "store/customers/acme/**" },
      ],
    };
    const ok = await core.runs.call({
      identity: alice,
      projectId,
      workflowName: "briefCustomer",
      input: { customer: "acme" },
      budgetMs: 20_000,
    });
    expect(ok.status).toBe("completed");
    if (ok.status !== "completed") return;
    expect(ok.output).toEqual({
      summary: "Acme wants faster refunds and a Q4 renew",
    });
    // The document read landed as the second step's input.
    const second = seen.find(
      (s) => s.exportName === "briefCustomer" && s.stepIndex === 1,
    );
    if (!second) throw new Error("second step never invoked");
    expect((second.input as { value: { text: string } }).value.text).toContain(
      "Q4 renewal",
    );

    // Same workflow, a customer outside Alice's scope: the host call is
    // denied and the step fails — the workflow author cannot widen it.
    const denied = await core.runs.call({
      identity: alice,
      projectId,
      workflowName: "briefCustomer",
      input: { customer: "globex" },
      budgetMs: 20_000,
    });
    expect(denied.status).toBe("failed");
    if (denied.status === "failed") {
      expect(denied.error).toMatch(
        /Host call catamorphic\.documents\.read failed/,
      );
    }
  });

  it("context.host.<capability>.<fn> reaches the registered call with the caller attached", async () => {
    const bob: Identity = {
      ...root,
      externalUserId: "bob",
      executionScope: [{ projectId, name: "local" }],
      scope: [{ kind: "workflow", projectId, name: "lookupAccount" }],
    };
    const outcome = await core.runs.call({
      identity: bob,
      projectId,
      workflowName: "lookupAccount",
      input: { id: "A-1" },
      budgetMs: 20_000,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.output).toEqual({ name: "Account A-1", seenBy: "bob" });
    expect(crmCalls.at(-1)).toMatchObject({
      caller: {
        externalUserId: "bob",
        scope: bob.scope,
        executionScope: bob.executionScope,
      },
      args: { id: "A-1" },
    });
  });
});
