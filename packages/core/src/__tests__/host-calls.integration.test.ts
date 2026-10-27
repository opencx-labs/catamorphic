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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import type {
  HostCallContext,
  HostCallFunction,
} from "../services/capability-providers.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
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
  permissions: ["sessions:write"],
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

/** @displayname Carry the account through two calls */
export const carryAccount = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ id: string }>) =>
        host.acme.crm.lookupAccount({ id: input.id }, { state: { asked: input.id } }),
    }),
    defineBoundary({
      run: ({ input, callWorkflow }: BoundaryContext<Carried<{ name: string; seenBy: string }, { asked: string }>>) =>
        callWorkflow(whoAmI, { input: {}, state: { ...input.state, name: input.result.name } }),
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<Carried<{ caller: unknown }, { asked: string; name: string }>>) => input,
    }),
  ],
}));

export const carryTooMuch = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ id: string }>) =>
        host.acme.crm.lookupAccount({ id: input.id }, { state: { blob: "" } }),
    }),
  ],
}));

/** @displayname Who am I */
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
  } else if (exportName === "carryTooMuch") {
    terminal = {
      status: "completed",
      result: {
        type: "host_call",
        transition: {
          __catamorphicDurableTransition: "host_call",
          capability: "acme.crm",
          fn: "lookupAccount",
          args: { id: value.id },
          statePresent: true,
          state: { blob: "x".repeat(300_000) },
        },
      },
      steps: [],
    };
  } else if (exportName === "carryAccount" && stepIndex === 0) {
    terminal = {
      status: "completed",
      result: {
        type: "host_call",
        transition: {
          __catamorphicDurableTransition: "host_call",
          capability: "acme.crm",
          fn: "lookupAccount",
          args: { id: value.id },
          statePresent: true,
          state: { asked: value.id },
        },
      },
      steps: [],
    };
  } else if (exportName === "carryAccount" && stepIndex === 1) {
    const carried = value as {
      result: { name: string };
      state: { asked: string };
    };
    terminal = {
      status: "completed",
      result: {
        type: "child_workflow",
        transition: {
          __catamorphicDurableTransition: "child_workflow",
          input: {},
          statePresent: true,
          state: { ...carried.state, name: carried.result.name },
          workflow: { exportName: "whoAmI" },
        },
      },
      steps: [],
    };
  } else if (exportName === "carryAccount") {
    terminal = {
      status: "completed",
      result: { type: "completed", output: value },
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

function deferred<T>() {
  let resolve: (value: T) => void = (_value: T) => {
    throw new Error("Promise has not initialized");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let runtimeOverride:
  | ((args: RuntimeInvocation) => Promise<RuntimeInvocationReceipt>)
  | undefined;

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
    invoke: (args) =>
      runtimeOverride ? runtimeOverride(args) : invokeRuntime(args),
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
  let hostOverride: HostCallFunction | undefined;

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
      credentialVault: new MemoryCredentialVault(),
      connectionProviders: [
        { kind: "fake", displayName: "Fake", invoke: async () => null },
      ],
      capabilityProviders: [
        {
          name: "acme.crm",
          calls: {
            lookupAccount: (context, args) => {
              if (hostOverride) return hostOverride(context, args);
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
    await core.projects.writeFile(
      root,
      projectId,
      ".work/workflows/src/brain.ts",
      {
        content: WORKFLOWS,
        commitMessage: "Add workflows",
      },
    );
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

  afterEach(async () => {
    await core.runs.stopWorkers();
    runtimeOverride = undefined;
    hostOverride = undefined;
    vi.restoreAllMocks();
  });

  async function enqueue(workflowName = "lookupAccount", remainingMs?: number) {
    const run = await core.runs.triggerProduction({
      identity: root,
      projectId,
      workflowName,
      input: { id: "bounded", customer: "acme" },
    });
    if (remainingMs !== undefined) {
      await db
        .updateTable("workflow_step_attempts")
        .set({ started_at: new Date(Date.now() - 300_000 + remainingMs) })
        .where("run_id", "=", run.id)
        .execute();
    }
    return run;
  }

  const startWorker = () =>
    core.runs.startWorker({
      kinds: ["durable_boundary"],
      concurrency: 1,
      pollIntervalMs: 5,
      leaseSeconds: 3,
    });

  it("shares the persisted attempt deadline with its callback and hung host call, then fences a late result", async () => {
    const late = deferred<unknown>();
    const called = deferred<HostCallContext>();
    const invoked = deferred<RuntimeInvocation>();
    runtimeOverride = async (invocation) => {
      invoked.resolve(invocation);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return invokeRuntime(invocation);
    };
    hostOverride = (context) => {
      called.resolve(context);
      return late.promise;
    };
    const run = await enqueue("lookupAccount", 1_500);
    const persisted = await db
      .selectFrom("workflow_step_attempts")
      .select("started_at")
      .where("run_id", "=", run.id)
      .executeTakeFirstOrThrow();
    startWorker();
    const context = await called.promise;
    const invocation = await invoked.promise;
    expect(context.signal).toBe(invocation.signal);
    expect(context.deadlineAt).toBe(invocation.deadlineAt);
    expect(Date.parse(context.deadlineAt)).toBe(
      persisted.started_at!.getTime() + 300_000,
    );
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: run.id })).status,
        { timeout: 5_000 },
      )
      .toBe("failed");
    expect(context.signal.aborted).toBe(true);
    late.resolve({ shouldNeverPersist: true });
    await core.runs.stopWorkers();
    const result = await core.runs.get({ identity: root, runId: run.id });
    expect(result.error).toMatch(/five-minute deadline/);
    expect(result.result).not.toEqual({ shouldNeverPersist: true });
  });

  it("does not reset an expired attempt's budget on job redelivery", async () => {
    const invoke = vi.fn(invokeRuntime);
    runtimeOverride = invoke;
    const run = await enqueue("lookupAccount", -1);
    startWorker();
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: run.id })).status,
      )
      .toBe("failed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a returned call when cancellation lands before dispatch", async () => {
    const host = vi.fn(() => ({ accepted: true }));
    hostOverride = host;
    const run = await enqueue();
    runtimeOverride = async (invocation) => {
      const receipt = await invokeRuntime(invocation);
      await core.runs.cancel({ identity: root, runId: run.id });
      return receipt;
    };
    const worker = startWorker();
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: run.id })).status,
      )
      .toBe("canceled");
    await worker.stop();
    expect(host).not.toHaveBeenCalled();
  });

  it("aborts an in-flight host call on cancellation and frees the lane even when it ignores the signal", async () => {
    const late = deferred<unknown>();
    const called = deferred<HostCallContext>();
    hostOverride = (context) => {
      called.resolve(context);
      return late.promise;
    };
    const run = await enqueue();
    startWorker();
    const context = await called.promise;
    await core.runs.cancel({ identity: root, runId: run.id });
    const next = await enqueue("whoAmI");
    await expect
      .poll(() => context.signal.aborted, { timeout: 4_000 })
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: next.id })).status,
        { timeout: 5_000 },
      )
      .toBe("completed");
    late.resolve({ shouldNeverPersist: true });
    await core.runs.stopWorkers();
    expect(
      (await core.runs.get({ identity: root, runId: run.id })).status,
    ).toBe("canceled");
  });

  it("bounds a returned connection call and passes the callback's deadline to the broker", async () => {
    const broker = core.connectionBroker;
    if (!broker) throw new Error("Fixture needs a connection broker");
    const called = deferred<Parameters<typeof broker.invoke>[0]>();
    const invoked = deferred<RuntimeInvocation>();
    vi.spyOn(broker, "invoke").mockImplementation((args) => {
      called.resolve(args);
      return new Promise(() => {});
    });
    runtimeOverride = async (invocation) => {
      invoked.resolve(invocation);
      return {
        runtimeId: invocation.runtimeId,
        invocationId: invocation.invocationId,
        events: [],
        terminal: {
          status: "completed",
          steps: [],
          result: {
            type: "connection_call",
            transition: { alias: "fake", action: "read", args: {} },
          },
        },
      };
    };
    const run = await enqueue("lookupAccount", 1_500);
    startWorker();
    const context = await called.promise;
    const invocation = await invoked.promise;
    expect(context.signal).toBe(invocation.signal);
    expect(context.deadlineAt).toBe(invocation.deadlineAt);
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: run.id })).status,
        { timeout: 5_000 },
      )
      .toBe("failed");
    expect(context.signal?.aborted).toBe(true);
  });

  it("worker shutdown aborts a hung provider without awaiting its cooperation", async () => {
    const called = deferred<HostCallContext>();
    hostOverride = (context) => {
      called.resolve(context);
      return new Promise(() => {});
    };
    const run = await enqueue();
    const worker = startWorker();
    const context = await called.promise;
    await worker.stop();
    expect(context.signal.aborted).toBe(true);
    const job = await db
      .selectFrom("execution_jobs")
      .select("status")
      .where("workflow_run_id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(job.status).toBe("pending");
    await core.runs.cancel({ identity: root, runId: run.id });
  });

  it("lease loss aborts a hung call and rejects its late receipt", async () => {
    const called = deferred<HostCallContext>();
    const late = deferred<unknown>();
    hostOverride = (context) => {
      called.resolve(context);
      return late.promise;
    };
    const run = await enqueue();
    const worker = startWorker();
    const context = await called.promise;
    await db
      .updateTable("execution_jobs")
      .set({ lease_expires_at: new Date(0) })
      .where("workflow_run_id", "=", run.id)
      .execute();
    await expect
      .poll(() => context.signal.aborted, { timeout: 4_000 })
      .toBe(true);
    late.resolve({ late: true });
    await worker.stop();
    const attempt = await db
      .selectFrom("workflow_step_attempts")
      .select(["status", "output"])
      .where("run_id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(attempt.status).toBe("running");
    expect(attempt.output).toBeNull();
    await core.runs.cancel({ identity: root, runId: run.id });
  });

  it("bounds a hung documents operation under the same attempt deadline", async () => {
    vi.spyOn(core.documents, "read").mockImplementation(
      () => new Promise(() => {}),
    );
    const run = await enqueue("briefCustomer", 1_500);
    startWorker();
    await expect
      .poll(
        async () =>
          (await core.runs.get({ identity: root, runId: run.id })).status,
        { timeout: 5_000 },
      )
      .toBe("failed");
  });

  it("the caller rides into every invocation, and a workflow can read it", async () => {
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      executionScope: [{ projectId, name: "default" }],
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
    // The run remembers the name people know the workflow by.
    expect(
      (await core.runs.get({ identity: root, runId: asRoot.runId })).provenance,
    ).toMatchObject({ displayName: "Who am I" });
  });

  it("context.documents runs as the caller: a covered path reads, an uncovered one fails the step", async () => {
    const alice: Identity = {
      ...root,
      externalUserId: "alice",
      executionScope: [{ projectId, name: "default" }],
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
      executionScope: [{ projectId, name: "default" }],
      scope: [{ kind: "workflow", projectId, name: "lookupAccount" }],
      projectPermissions: [
        { projectId, permission: "sessions:*" },
        { projectId, permission: "secrets:write" },
      ],
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
        // Only what the workflow declares, of what Bob holds (ADR 0158).
        projectPermissions: [{ projectId, permission: "sessions:write" }],
      },
      args: { id: "A-1" },
    });
  });

  it("a returned call carries state to the next step beside its result (ADR 0260)", async () => {
    const outcome = await core.runs.call({
      identity: root,
      projectId,
      workflowName: "carryAccount",
      input: { id: "A-2" },
      budgetMs: 20_000,
    });
    // The run waits on its child, then finishes on a worker.
    const worker = core.runs.startWorker({
      name: "carry-state",
      kinds: ["durable_boundary"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    let run = { status: "", result: null as unknown };
    try {
      for (let tries = 0; tries < 300 && run.status !== "completed"; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = await db
          .selectFrom("workflow_runs")
          .select(["status", "result"])
          .where("id", "=", outcome.runId)
          .executeTakeFirstOrThrow();
      }
    } finally {
      await worker.stop();
    }
    expect(run.status).toBe("completed");
    // A host call, then a child workflow, each with state: the step after
    // each receives { result, state }.
    const inputOf = (stepIndex: number) =>
      (
        seen.find(
          (entry) =>
            entry.exportName === "carryAccount" &&
            entry.stepIndex === stepIndex,
        )?.input as { value?: unknown } | undefined
      )?.value;
    expect(inputOf(1)).toEqual({
      result: { name: "Account A-2", seenBy: "root" },
      state: { asked: "A-2" },
    });
    expect(run.result).toEqual({
      result: { caller: { externalUserId: "root" } },
      state: { asked: "A-2", name: "Account A-2" },
    });
    // The waiting step held the child's state on its row.
    const held = await db
      .selectFrom("workflow_step_attempts")
      .select(["call_state_present", "call_state"])
      .where("run_id", "=", outcome.runId)
      .where("step_index", "=", 1)
      .executeTakeFirstOrThrow();
    expect(held).toEqual({
      call_state_present: true,
      call_state: { asked: "A-2", name: "Account A-2" },
    });
  });

  it("refuses state over 256 KiB before the call runs", async () => {
    const before = crmCalls.length;
    const outcome = await core.runs.call({
      identity: root,
      projectId,
      workflowName: "carryTooMuch",
      input: { id: "A-3" },
      budgetMs: 20_000,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed")
      expect(outcome.error).toMatch(/at most 262144 ride with it/);
    expect(crmCalls).toHaveLength(before);
  });
});
