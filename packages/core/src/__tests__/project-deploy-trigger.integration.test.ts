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
  SandboxProvider,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ProjectEventDispatcher } from "../services/project-event-dispatcher.js";
import {
  DEPLOY_WORKFLOW_REMOVED,
  PROJECT_DEPLOY_EVENT,
} from "../services/published-revisions-service.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import { testEnvironmentProvider } from "./test-environment.js";

/**
 * A revision's deploy as core runs it (ADRs 0331, 0355): the bindings of
 * `project.deploy` are read from the published commit's own source, each
 * listening project automation's run starts at that commit through the
 * runs service, stamped with the event, and the revision goes live when
 * they succeeded. Only the runtime is faked, at the invocation boundary:
 * a run completes with its input, or fails while `failing` names it.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_project_deploy_${crypto.randomUUID().replaceAll("-", "")}`;

const root: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "root",
};

/** The kind as a host registers it: no config, one event per try. */
const deployKind: TriggerKindRuntime = {
  name: PROJECT_DEPLOY_EVENT,
  modes: ["async"],
  payloadJsonSchema: { type: "object" },
  configJsonSchema: { type: "object" },
  validatePayload: () => ({ ok: true }),
  validateConfig: () => ({ ok: true }),
};

/** The project's workflows; `bound` names those that bind the deploy. */
const workflows = (input: { note: string; bound: readonly string[] }) => `
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";
// ${input.note}
${["migrate", "seed", "report"]
  .map(
    (name) => `
export const ${name} = defineWorkflow(({ defineBoundary }) => ({
  ${input.bound.includes(name) ? 'triggers: [trigger("project.deploy")],' : ""}
  steps: [
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => ({ ran: "${name}", input }) }),
  ],
}));`,
  )
  .join("\n")}
`;

/** Runs of this workflow fail while set. */
let failing: string | null = null;
/** What each run was invoked with, by workflow export. */
const invoked: Array<{ workflow: string; input: unknown }> = [];

function invokeRuntime(
  invocation: RuntimeInvocation,
): Promise<RuntimeInvocationReceipt> {
  if (invocation.kind !== "durable-boundary")
    throw new Error(`Unexpected invocation kind '${invocation.kind}'`);
  const workflow = invocation.target.exportName;
  const raw = invocation.input as { value?: unknown };
  invoked.push({ workflow, input: raw.value });
  return Promise.resolve({
    runtimeId: invocation.runtimeId,
    invocationId: invocation.invocationId,
    events: [],
    terminal:
      failing === workflow
        ? { status: "failed", error: "relation already exists", steps: [] }
        : {
            status: "completed",
            result: { type: "completed", output: { ran: workflow } },
            steps: [],
          },
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

describeIf("a revision's deploy through core (ADRs 0331, 0355)", () => {
  let tmpDir: string;
  let core: CatamorphicCore;
  let db: ReturnType<typeof createDatabase>;
  let projectId: string;
  let migrate: string;
  let report: string;

  /** Commit the program with `bound` listening, and publish it. */
  async function publish(input: {
    note: string;
    bound: readonly string[];
  }): Promise<string> {
    await core.projects.writeFile(
      root,
      projectId,
      ".work/workflows/src/deploy.ts",
      { content: workflows(input), commitMessage: input.note },
    );
    const deployed = await core.deployment.deploy(
      root.tenantId,
      projectId,
      root.externalUserId,
      { message: input.note },
    );
    expect(deployed.status).toBe("deployed");
    return (await latest()).commitSha;
  }

  const latest = async () => {
    const [revision] = await core.publishedRevisions.list({
      identity: root,
      projectId,
    });
    if (!revision) throw new Error("No revision was published");
    return revision;
  };

  async function enable(workflowName: string): Promise<string> {
    const preview = await core.workflowEnablements.preview({
      identity: root,
      projectId,
      workflowName,
      owner: { type: "project" },
    });
    const created = await core.workflowEnablements.create({
      identity: root,
      projectId,
      workflowName,
      owner: { type: "project" },
      consentDigest: preview.consentDigest,
    });
    return created.id;
  }

  const commitOf = async (enablementId: string) =>
    (await core.workflowEnablements.get({ identity: root, enablementId }))
      .commitSha;

  /** Run the deploy runs the latest revision started, to their end. */
  async function runDeploy() {
    const { deployRuns } = await latest();
    for (const run of deployRuns) {
      if (!run.runId) throw new Error(`${run.workflowName} has no run`);
      await core.runs.driveInline({
        tenantId: root.tenantId,
        runId: run.runId,
        deadline: Date.now() + 30_000,
      });
    }
    return deployRuns;
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-project-deploy-"),
    );
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    db = createDatabase({ connectionString, schema, poolSize: 8 });
    await migrateToLatest({ db, schema });
    const sandboxProvider = new FakeSandboxProvider();
    core = new CatamorphicCore({
      hostId: "project-deploy-fixture",
      codingAgent: {
        id: "echo",
        harness: { placement: "host", adapter: new EchoAdapter() },
        topology: "native",
      },
      db,
      projectManager,
      sandboxProvider,
      environmentProvider: testEnvironmentProvider(sandboxProvider),
      credentialVault: new MemoryCredentialVault(),
      triggerKinds: [deployKind],
    });
    projectId = (await core.projects.create(root, { name: "deploys" })).id;
  }, 180_000);

  afterAll(async () => {
    await core.runs.stopWorkers();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("goes live with no deploy step while no project automation listens", async () => {
    const first = await publish({ note: "first", bound: ["migrate"] });
    await core.publishedRevisions.advance();
    // `migrate` binds the event and nobody turned it on: nothing runs.
    expect(await latest()).toMatchObject({
      commitSha: first,
      status: "applied",
      deployEventId: null,
      deployRuns: [],
    });
    expect(invoked).toEqual([]);
    migrate = await enable("migrate");
    report = await enable("report");
  }, 120_000);

  it("runs the listener at the new revision for the one event, then moves what follows", async () => {
    const live = await commitOf(migrate);
    const next = await publish({ note: "second", bound: ["migrate"] });
    await core.publishedRevisions.advance();
    const deploying = await latest();
    expect(deploying).toMatchObject({
      commitSha: next,
      status: "deploying",
      previousCommitSha: live,
      deployRuns: [{ workflowName: "migrate", runId: expect.any(String) }],
    });
    // Nothing moved while the deploy runs.
    expect(await commitOf(migrate)).toBe(live);
    expect(await commitOf(report)).toBe(live);

    const [run] = await runDeploy();
    const stored = await db
      .selectFrom("workflow_runs")
      .select(["event_id", "status", "provenance", "workflow_enablement_id"])
      .where("id", "=", run?.runId ?? "")
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      event_id: deploying.deployEventId,
      status: "completed",
      // The new commit's code, through the automation turned on before it.
      provenance: expect.objectContaining({ commitSha: next }),
      workflow_enablement_id: migrate,
    });
    expect(invoked).toEqual([
      {
        workflow: "migrate",
        input: expect.objectContaining({
          id: deploying.deployEventId,
          kind: PROJECT_DEPLOY_EVENT,
          source: "project",
          payload: expect.objectContaining({
            detail: { commit: next, previousCommit: live },
          }),
        }),
      },
    ]);
    // The dispatcher has nothing to deliver for an event its emitter
    // delivers at the revision.
    expect(
      await new ProjectEventDispatcher(
        db,
        core.triggers,
        core.workflowEnablements,
      ).dispatch(),
    ).toBe(0);
    expect(
      await db
        .selectFrom("project_event_deliveries")
        .select("event_id")
        .where("event_id", "=", deploying.deployEventId ?? "")
        .execute(),
    ).toEqual([]);

    await core.publishedRevisions.advance();
    expect((await latest()).status).toBe("applied");
    expect(await commitOf(migrate)).toBe(next);
    expect(await commitOf(report)).toBe(next);
  }, 120_000);

  it("keeps a revision from going live when a deploy run fails", async () => {
    invoked.length = 0;
    const live = await commitOf(migrate);
    failing = "migrate";
    const next = await publish({ note: "third", bound: ["migrate"] });
    await core.publishedRevisions.advance();
    await runDeploy();
    await core.publishedRevisions.advance();
    failing = null;
    expect(await latest()).toMatchObject({
      commitSha: next,
      status: "failed",
      error: expect.stringContaining("The deploy workflow migrate failed"),
    });
    expect((await latest()).error).toContain(
      "Nothing moved; the previous revision stays live.",
    );
    expect(await commitOf(migrate)).toBe(live);
    expect(await commitOf(report)).toBe(live);
  }, 120_000);

  it("fails a revision that makes a turned-on workflow listen until its automation is consented to again", async () => {
    invoked.length = 0;
    const live = await commitOf(report);
    // `report` starts listening: what starts it changed.
    const next = await publish({ note: "fourth", bound: ["report"] });
    await core.publishedRevisions.advance();
    expect(await latest()).toMatchObject({
      commitSha: next,
      status: "failed",
      error: expect.stringContaining(
        "The deploy workflow report could not start: This revision changes what the workflow may use or what starts it",
      ),
    });
    expect(invoked).toEqual([]);
    expect(await commitOf(report)).toBe(live);

    const preview = await core.workflowEnablements.preview({
      identity: root,
      projectId,
      workflowName: "report",
      owner: { type: "project" },
      commitSha: next,
    });
    await core.workflowEnablements.updateDeployment({
      identity: root,
      enablementId: report,
      consentDigest: preview.consentDigest,
      commitSha: next,
    });
    // Consenting tries the revision again by itself.
    expect((await latest()).status).toBe("pending");
    await core.publishedRevisions.advance();
    await runDeploy();
    await core.publishedRevisions.advance();
    expect((await latest()).status).toBe("applied");
    expect(invoked.map((call) => call.workflow)).toEqual(["report"]);
  }, 120_000);

  it("does not go live while the manifest still names a deploy workflow", async () => {
    invoked.length = 0;
    await core.projects.writeFile(root, projectId, PROJECT_MANIFEST_PATH, {
      content: JSON.stringify({ deploy: { workflow: "migrate" } }),
      commitMessage: "Name a deploy workflow",
    });
    await publish({ note: "fifth", bound: ["report"] });
    await core.publishedRevisions.advance();
    expect(await latest()).toMatchObject({
      status: "failed",
      error: DEPLOY_WORKFLOW_REMOVED,
    });
    expect(invoked).toEqual([]);
  }, 120_000);
});
