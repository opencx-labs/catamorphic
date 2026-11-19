import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EchoAdapter } from "@catamorphic/agent-runner";
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * ADR 0335: a workflow declares the store paths its runs read or write.
 * A project automation runs as the project principal holding exactly the
 * consented paths; any other scoped run (a member's own automation, a run
 * a member starts directly) holds what both the declaration and its caller
 * reach; a child holds what its parent holds of its own declaration; and a
 * revision that widens the declaration waits for consent while a narrower
 * one follows. The runtime is faked at the
 * invocation boundary: each workflow's first step returns the documents
 * call its input names, its second returns that call's result.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_workflow_documents_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

const DECLARED = `[
    { path: "store/polling/", access: "write" },
    { path: "store/config.json", access: "read" },
  ]`;

const workflows = (documents: string) => `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

type Op = { op: string; path?: string; prefix?: string; child?: Op };

export const keepCursor = defineWorkflow(({ defineBoundary }) => ({
  documents: ${documents},
  steps: [
    defineBoundary({ run: ({ input }: BoundaryContext<Op>) => input }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => ({ result: input }) }),
  ],
}));

export const readConfig = defineWorkflow(({ defineBoundary }) => ({
  documents: [{ path: "store/config.json", access: "read" }],
  steps: [
    defineBoundary({ run: ({ input }: BoundaryContext<Op>) => input }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => ({ result: input }) }),
  ],
}));
`;

type Op = {
  op: string;
  path?: string;
  prefix?: string;
  child?: Op;
  key?: string;
};

/**
 * A second project's workflows: runs of queuedCursor about one key take
 * turns, and noteKeeper keeps notes.
 */
const queueWorkflows = (input: { queued: string; notes: string }) => `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

type Op = { op: string; path?: string; key?: string };

export const queuedCursor = defineWorkflow(({ defineBoundary }) => ({
  concurrency: { key: "key", onConflict: "queue" },
  documents: ${input.queued},
  steps: [
    defineBoundary({ run: ({ input }: BoundaryContext<Op>) => input }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => ({ result: input }) }),
  ],
}));

export const noteKeeper = defineWorkflow(({ defineBoundary }) => ({
  documents: ${input.notes},
  steps: [
    defineBoundary({ run: ({ input }: BoundaryContext<Op>) => input }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => ({ result: input }) }),
  ],
}));
`;

function terminalFor(
  value: Op,
): Extract<RuntimeTerminalResult, { status: "completed" }>["result"] {
  if (value.op === "child")
    return {
      type: "child_workflow",
      transition: {
        __catamorphicDurableTransition: "child_workflow",
        input: value.child ?? {},
        workflow: { exportName: "readConfig" },
      },
    };
  const args =
    value.op === "write"
      ? {
          path: value.path,
          text: JSON.stringify({ at: value.path }),
          contentType: "application/json",
        }
      : value.op === "list"
        ? { prefix: value.prefix, source: "store" }
        : { path: value.path };
  return {
    type: "host_call",
    transition: {
      __catamorphicDurableTransition: "host_call",
      capability: DOCUMENTS_CAPABILITY,
      fn: value.op,
      args,
    },
  };
}

function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind !== "durable-boundary")
    throw new Error(`Unexpected invocation kind '${invocation.kind}'`);
  const raw = invocation.input as { value?: unknown };
  const terminal: RuntimeTerminalResult = {
    status: "completed",
    result:
      invocation.target.stepIndex === 0
        ? terminalFor((raw.value ?? {}) as Op)
        : { type: "completed", output: { result: raw.value ?? null } },
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

describeIf("workflows declare the store documents they use (ADR 0335)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
  let projectEnablement: string;
  /** Members as the host resolves them now. */
  const members = new Map<string, Identity>();

  const member = (
    externalUserId: string,
    extra: Pick<Identity, "scope" | "projectPermissions">,
  ): Identity => ({
    tenantId: root.tenantId,
    externalUserId,
    executionScope: [{ projectId, name: "default" }],
    ...extra,
    scope: [{ kind: "workflow", projectId, name: "*" }, ...(extra.scope ?? [])],
  });

  async function runEnablement(
    enablementId: string,
    input: Op,
    identity: Identity = root,
  ) {
    const run = await core.runs.triggerWithEnablement({
      identity,
      projectId,
      workflowName: "keepCursor",
      enablementId,
      input,
    });
    return core.runs.driveInline({
      tenantId: root.tenantId,
      runId: run.id,
      deadline: Date.now() + 30_000,
    });
  }

  async function deploy(documents: string, message: string) {
    await core.projects.writeFile(
      root,
      projectId,
      ".work/workflows/src/cursor.ts",
      { content: workflows(documents), commitMessage: message },
    );
    const deployed = await core.deployment.deploy(
      root.tenantId,
      projectId,
      root.externalUserId,
      { message },
    );
    expect(deployed.status).toBe("deployed");
  }

  const enablement = (enablementId: string) =>
    core.workflowEnablements.get({ identity: root, enablementId });

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-workflow-documents-"),
    );
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const sandboxProvider = new FakeSandboxProvider();
    core = new CatamorphicCore({
      hostId: "workflow-documents-fixture",
      codingAgent: {
        id: "echo",
        harness: { placement: "host", adapter: new EchoAdapter() },
        topology: "native",
      },
      resolveMemberIdentity: async ({ externalUserId }) =>
        members.get(externalUserId) ?? null,
      db,
      projectManager,
      sandboxProvider,
      environmentProvider: testEnvironmentProvider(sandboxProvider),
      credentialVault: new MemoryCredentialVault(),
    });
    const project = await core.projects.create(root, { name: "documents" });
    projectId = project.id;
    await deploy(DECLARED, "Add the cursor keeper");
    for (const [documentPath, content] of [
      ["store/config.json", '{"repository":"web"}'],
      ["store/secrets.json", '{"token":"never"}'],
      ["store/polling-old/web.json", "{}"],
      ["store/pollingx.json", "{}"],
    ] as const)
      await core.documents.write({
        identity: root,
        projectId,
        path: documentPath,
        content,
      });
  }, 180_000);

  afterAll(async () => {
    await core.runs.stopWorkers();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await core.runs.stopWorkers();
  });

  it("shows the documents when turning it on, and the consent covers them", async () => {
    const preview = await core.workflowEnablements.preview({
      identity: root,
      projectId,
      workflowName: "keepCursor",
      owner: { type: "project" },
    });
    expect(preview.documents).toEqual([
      { path: "store/config.json", access: "read" },
      { path: "store/polling/", access: "write" },
    ]);
    const created = await core.workflowEnablements.create({
      identity: root,
      projectId,
      workflowName: "keepCursor",
      owner: { type: "project" },
      consentDigest: preview.consentDigest,
    });
    projectEnablement = created.id;
    expect(created).toMatchObject({
      owner: { type: "project" },
      follow: true,
      documents: preview.documents,
    });
  });

  it("refuses the project consent of someone who cannot reach the declared documents", async () => {
    const nadia = member("nadia", {
      scope: [
        {
          kind: "document",
          projectId,
          path: "store/polling/**",
          access: "read",
        },
      ],
      projectPermissions: [{ projectId, permission: "automations:write" }],
    });
    await expect(
      core.workflowEnablements.preview({
        identity: nadia,
        projectId,
        workflowName: "keepCursor",
        owner: { type: "project" },
      }),
    ).rejects.toThrow(
      new AccessDeniedError(
        "This workflow uses store documents you cannot reach: store/config.json (read), store/polling/ (write)",
      ),
    );
  });

  it("a project automation writes and reads what it declares, and nothing else of the store", async () => {
    const wrote = await runEnablement(projectEnablement, {
      op: "write",
      path: "store/polling/web.json",
    });
    expect(wrote).toMatchObject({ status: "completed" });
    expect(
      await runEnablement(projectEnablement, {
        op: "read",
        path: "store/polling/web.json",
      }),
    ).toMatchObject({
      status: "completed",
      output: { result: { text: '{"at":"store/polling/web.json"}' } },
    });
    const listed = await runEnablement(projectEnablement, {
      op: "list",
      prefix: "store",
    });
    expect(listed.status).toBe("completed");
    // Only what it declares shows in a list of the whole store.
    expect(
      listed.status === "completed"
        ? (listed.output as { result: Array<{ path: string }> }).result.map(
            (entry) => entry.path,
          )
        : [],
    ).toEqual(["store/config.json", "store/polling/web.json"]);
    expect(
      await runEnablement(projectEnablement, {
        op: "read",
        path: "store/config.json",
      }),
    ).toMatchObject({ status: "completed" });

    for (const refused of [
      { op: "write", path: "store/config.json" },
      { op: "read", path: "store/secrets.json" },
      { op: "read", path: "store/pollingx.json" },
      { op: "read", path: "store/polling-old/web.json" },
    ]) {
      const outcome = await runEnablement(projectEnablement, refused);
      expect(outcome.status, `${refused.op} ${refused.path}`).toBe("failed");
      if (outcome.status === "failed")
        expect(outcome.error).toMatch(
          new RegExp(
            `Host call catamorphic\\.documents\\.${refused.op} failed`,
          ),
        );
    }
  });

  it("a child run holds what its parent holds of the child's own declaration", async () => {
    // The parent waits on its child, which runs on a worker.
    const worker = core.runs.startWorker({
      name: "workflow-documents-children",
      kinds: ["durable_boundary"],
      concurrency: 2,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });
    const childOf = async (child: Op) => {
      const parent = await runEnablement(projectEnablement, {
        op: "child",
        child,
      });
      for (let tries = 0; tries < 300; tries++) {
        const row = await db
          .selectFrom("workflow_runs")
          .select(["status", "error"])
          .where("parent_run_id", "=", parent.runId)
          .executeTakeFirst();
        if (row && ["completed", "failed", "canceled"].includes(row.status))
          return row;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("The child run never settled");
    };
    try {
      // readConfig declares only store/config.json.
      expect(
        await childOf({ op: "read", path: "store/config.json" }),
      ).toMatchObject({ status: "completed" });
      // Its parent holds store/polling/, but the child does not declare it.
      const refused = await childOf({
        op: "read",
        path: "store/polling/web.json",
      });
      expect(refused.status).toBe("failed");
      expect(refused.error).toMatch(
        /Host call catamorphic\.documents\.read failed/,
      );
    } finally {
      await worker.stop();
    }
  });

  it("a member's own automation reaches only what both the declaration and the member reach", async () => {
    let mira = member("mira", {
      scope: [
        { kind: "document", projectId, path: "store/**", access: "read" },
        {
          kind: "document",
          projectId,
          path: "store/polling/mira/**",
          access: "write",
        },
      ],
    });
    members.set("mira", mira);
    const preview = await core.workflowEnablements.preview({
      identity: mira,
      projectId,
      workflowName: "keepCursor",
    });
    const own = await core.workflowEnablements.create({
      identity: mira,
      projectId,
      workflowName: "keepCursor",
      consentDigest: preview.consentDigest,
    });
    const as = (op: Op) => runEnablement(own.id, op, mira);

    expect(
      await as({ op: "write", path: "store/polling/mira/web.json" }),
    ).toMatchObject({ status: "completed" });
    expect(
      await as({ op: "read", path: "store/polling/web.json" }),
    ).toMatchObject({ status: "completed" });
    // Declared, but mira only reads it.
    expect(
      await as({ op: "write", path: "store/polling/web.json" }),
    ).toMatchObject({ status: "failed" });
    // Mira reaches it, but the workflow does not declare it.
    expect(await as({ op: "read", path: "store/secrets.json" })).toMatchObject({
      status: "failed",
    });

    // What mira reaches now decides every run: her write grant is gone.
    mira = member("mira", {
      scope: [
        { kind: "document", projectId, path: "store/**", access: "read" },
      ],
    });
    members.set("mira", mira);
    expect(
      await as({ op: "write", path: "store/polling/mira/web.json" }),
    ).toMatchObject({ status: "failed" });
  });

  it("a run a member starts directly reaches only the store paths its workflow declares", async () => {
    const ola = member("ola", {
      scope: [
        { kind: "document", projectId, path: "store/**", access: "write" },
      ],
    });
    const call = (workflowName: string, input: Op, identity = ola) =>
      core.runs.call({
        identity,
        projectId,
        workflowName,
        input,
        budgetMs: 20_000,
      });
    // Declared, and ola writes the whole store.
    expect(
      await call("keepCursor", { op: "write", path: "store/polling/ola.json" }),
    ).toMatchObject({ status: "completed" });
    // Ola writes it too, but the workflow does not declare it.
    const undeclared = await call("keepCursor", {
      op: "write",
      path: "store/secrets.json",
    });
    expect(undeclared.status).toBe("failed");
    if (undeclared.status === "failed")
      expect(undeclared.error).toMatch(
        /Host call catamorphic\.documents\.write failed/,
      );
    // Declared read only: no write, whoever starts it.
    expect(
      await call("keepCursor", { op: "write", path: "store/config.json" }),
    ).toMatchObject({ status: "failed" });
    // Each workflow by its own list: readConfig declares only the config.
    expect(
      await call("readConfig", { op: "read", path: "store/config.json" }),
    ).toMatchObject({ status: "completed" });
    expect(
      await call("readConfig", { op: "read", path: "store/polling/ola.json" }),
    ).toMatchObject({ status: "failed" });
    // The root identity (a desktop's own projects, a host's service) is
    // not narrowed.
    expect(
      await call(
        "keepCursor",
        { op: "read", path: "store/secrets.json" },
        root,
      ),
    ).toMatchObject({ status: "completed" });
  });

  it("a revision that widens the documents waits for consent; a narrower one follows", async () => {
    const consented = await enablement(projectEnablement);

    // read becomes write: stays, and offers the update.
    await deploy(
      `[
    { path: "store/polling/", access: "write" },
    { path: "store/config.json", access: "write" },
  ]`,
      "Write the config too",
    );
    await core.publishedRevisions.advance();
    expect(await enablement(projectEnablement)).toMatchObject({
      commitSha: consented.commitSha,
      updateAvailable: true,
      documents: consented.documents,
    });

    // A new path: stays too.
    await deploy(
      `[
    { path: "store/polling/", access: "write" },
    { path: "store/config.json", access: "read" },
    { path: "store/secrets.json", access: "read" },
  ]`,
      "Read the secrets",
    );
    await core.publishedRevisions.advance();
    expect(await enablement(projectEnablement)).toMatchObject({
      commitSha: consented.commitSha,
      documents: consented.documents,
    });

    // Narrower: one document under the folder, read only. It follows.
    await deploy(
      '[{ path: "store/polling/web.json", access: "read" }]',
      "Only read the cursor",
    );
    await core.publishedRevisions.advance();
    const narrowed = await enablement(projectEnablement);
    expect(narrowed.commitSha).not.toBe(consented.commitSha);
    expect(narrowed.documents).toEqual([
      { path: "store/polling/web.json", access: "read" },
    ]);
    // Its runs hold the narrower list.
    expect(
      await runEnablement(projectEnablement, {
        op: "read",
        path: "store/polling/web.json",
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await runEnablement(projectEnablement, {
        op: "write",
        path: "store/polling/web.json",
      }),
    ).toMatchObject({ status: "failed" });

    // Widening back to what was first consented asks again.
    await deploy(DECLARED, "Write the cursor again");
    await core.publishedRevisions.advance();
    expect(await enablement(projectEnablement)).toMatchObject({
      commitSha: narrowed.commitSha,
      updateAvailable: true,
    });
  });

  describe("queued runs and consent given again", () => {
    let queueProject: string;
    let queueAutomation: string;
    const WRITE = '[{ path: "store/queue/", access: "write" }]';
    const READ = '[{ path: "store/queue/", access: "read" }]';
    const NOTES_WRITE = '[{ path: "store/notes/", access: "write" }]';
    const NOTES_READ = '[{ path: "store/notes/", access: "read" }]';
    let sources = { queued: WRITE, notes: NOTES_WRITE };

    const admin = (externalUserId: string): Identity => ({
      tenantId: root.tenantId,
      externalUserId,
      executionScope: [{ projectId: queueProject, name: "default" }],
      scope: [
        { kind: "workflow", projectId: queueProject, name: "*" },
        {
          kind: "document",
          projectId: queueProject,
          path: "store/**",
          access: "write",
        },
      ],
      projectPermissions: [
        { projectId: queueProject, permission: "automations:write" },
      ],
    });

    async function deployQueue(change: Partial<typeof sources>) {
      sources = { ...sources, ...change };
      await core.projects.writeFile(
        root,
        queueProject,
        ".work/workflows/src/queue.ts",
        { content: queueWorkflows(sources), commitMessage: "Queue" },
      );
      const deployed = await core.deployment.deploy(
        root.tenantId,
        queueProject,
        root.externalUserId,
        { message: "Queue" },
      );
      expect(deployed.status).toBe("deployed");
      await core.publishedRevisions.advance();
    }

    async function enableQueue(input: {
      workflowName: string;
      identity: Identity;
      owner?: { type: "project" };
    }) {
      const preview = await core.workflowEnablements.preview({
        ...input,
        projectId: queueProject,
      });
      return core.workflowEnablements.create({
        ...input,
        projectId: queueProject,
        consentDigest: preview.consentDigest,
      });
    }

    /** A run of `key` that stays live, and one queued behind it. */
    async function queueBehind(input: {
      enablementId: string;
      identity: Identity;
      key: string;
      op: Op;
    }) {
      const trigger = (op: Op) =>
        core.runs.triggerWithEnablement({
          identity: input.identity,
          projectId: queueProject,
          workflowName: "queuedCursor",
          enablementId: input.enablementId,
          input: { ...op, key: input.key },
        });
      const ahead = await trigger({ op: "read", path: "store/queue/none" });
      const behind = await trigger(input.op);
      expect(behind.status).toBe("queued");
      return { ahead: ahead.id, behind: behind.id };
    }

    /** The live run ends; the queued one starts as it is now, and runs. */
    async function startBehind(queued: { ahead: string; behind: string }) {
      await core.runs.cancel({ identity: root, runId: queued.ahead });
      await core.runs.startQueuedRuns({ runId: queued.ahead });
      return core.runs.driveInline({
        tenantId: root.tenantId,
        runId: queued.behind,
        deadline: Date.now() + 30_000,
      });
    }

    beforeAll(async () => {
      queueProject = (await core.projects.create(root, { name: "queue" })).id;
      await deployQueue({});
      queueAutomation = (
        await enableQueue({
          workflowName: "queuedCursor",
          identity: root,
          owner: { type: "project" },
        })
      ).id;
    }, 120_000);

    it("a queued run starts with what a following revision narrowed its documents to", async () => {
      const queued = await queueBehind({
        enablementId: queueAutomation,
        identity: root,
        key: "narrowed",
        op: { op: "write", path: "store/queue/narrowed.json" },
      });
      const before = (await enablement(queueAutomation)).commitSha;
      await deployQueue({ queued: READ });
      expect((await enablement(queueAutomation)).commitSha).not.toBe(before);
      const started = await startBehind(queued);
      expect(started.status).toBe("failed");
      if (started.status === "failed")
        expect(started.error).toMatch(
          /Host call catamorphic\.documents\.write failed/,
        );
    });

    it("a queued run starts with the documents consented to since it queued", async () => {
      const queued = await queueBehind({
        enablementId: queueAutomation,
        identity: root,
        key: "widened",
        op: { op: "write", path: "store/queue/widened.json" },
      });
      // Widening waits for consent, then a person gives it.
      await deployQueue({ queued: WRITE });
      const waiting = await enablement(queueAutomation);
      expect(waiting.documents).toEqual([
        { path: "store/queue/", access: "read" },
      ]);
      const preview = await core.workflowEnablements.preview({
        identity: root,
        projectId: queueProject,
        workflowName: "queuedCursor",
        owner: { type: "project" },
      });
      await core.workflowEnablements.updateDeployment({
        identity: root,
        enablementId: queueAutomation,
        consentDigest: preview.consentDigest,
      });
      expect((await enablement(queueAutomation)).documents).toEqual([
        { path: "store/queue/", access: "write" },
      ]);
      expect(await startBehind(queued)).toMatchObject({ status: "completed" });
    });

    it("a member's queued run starts with what the member reaches when it starts", async () => {
      const nour = admin("nour");
      members.set("nour", nour);
      const own = await enableQueue({
        workflowName: "queuedCursor",
        identity: nour,
      });
      const queued = await queueBehind({
        enablementId: own.id,
        identity: nour,
        key: "member",
        op: { op: "write", path: "store/queue/nour.json" },
      });
      // Nour now only reads the store.
      members.set("nour", {
        ...nour,
        scope: [
          { kind: "workflow", projectId: queueProject, name: "*" },
          {
            kind: "document",
            projectId: queueProject,
            path: "store/**",
            access: "read",
          },
        ],
      });
      expect(await startBehind(queued)).toMatchObject({ status: "failed" });
    });

    it("another admin's consent keeps a project automation following after its first consenter leaves", async () => {
      const ada = admin("ada");
      const bea = admin("bea");
      members.set("ada", ada);
      members.set("bea", bea);
      const notes = await enableQueue({
        workflowName: "noteKeeper",
        identity: ada,
        owner: { type: "project" },
      });
      members.delete("ada");
      const preview = await core.workflowEnablements.preview({
        identity: bea,
        projectId: queueProject,
        workflowName: "noteKeeper",
        owner: { type: "project" },
      });
      await core.workflowEnablements.updateDeployment({
        identity: bea,
        enablementId: notes.id,
        consentDigest: preview.consentDigest,
      });
      const consented = await enablement(notes.id);
      // A narrower revision follows, previewed as bea.
      await deployQueue({ notes: NOTES_READ });
      const followed = await enablement(notes.id);
      expect(followed.commitSha).not.toBe(consented.commitSha);
      expect(followed.documents).toEqual([
        { path: "store/notes/", access: "read" },
      ]);
    });
  });
});
