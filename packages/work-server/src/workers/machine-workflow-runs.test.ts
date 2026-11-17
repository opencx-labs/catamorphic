import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import { WorkerNodesService } from "@catamorphic/core";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { installTarget } from "./install-script.js";
import { MachineReconciler, sharedName } from "./machine-rules.js";
import { ProjectMachineWorkflows } from "./machine-workflows.js";
import { WorkWorkerRegistry } from "./worker-registry.js";

/**
 * A project's own workflows make and remove machines (ADR 0327), end to
 * end: the provisioner project deploys `createMachine` and
 * `destroyMachine`, turns them on for the project, and the reconciler runs
 * them through that enablement, reading each answer on a later pass.
 */
const PUBLIC = "https://brain.example.test";
const ENG = "eng@example.com";

const PROVISIONER = `import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

type Create = { name: string; rule: string; options?: { prefix?: string }; enrollment: { idempotencyKey: string } };
type Destroy = { name: string; ref: string | null };

/** @displayname Create machine */
export const createMachine = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("machine.create")],
  steps: [
    /** @displayname Launch it */
    defineBoundary({
      run: async ({ input }: BoundaryContext<Create>) =>
        input.rule === "refused"
          ? { refused: "no capacity" }
          : { ref: \`\${input.options?.prefix ?? "vm"}-\${input.enrollment.idempotencyKey.slice(0, 8)}\` },
    }),
  ],
}));

/** @displayname Destroy machine */
export const destroyMachine = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("machine.destroy")],
  steps: [
    /** @displayname Terminate it */
    defineBoundary({
      run: async ({ input }: BoundaryContext<Destroy>) => ({ done: input.name.length > 0 }),
    }),
  ],
}));
`;

let root: string;
let server: WorkServer;
let projectId: string;
const setup: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-workflows-e2e-"));
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        PATH: process.env.PATH,
      },
    }),
  );
  const core = server.catamorphic.core;
  const project = await core.projects.create(setup, { name: "Machines" });
  projectId = project.id;
  const deployed = await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    setup.externalUserId,
    {
      message: "Machine provisioner",
      files: {
        ".work/project.json": JSON.stringify({
          environments: { default: { workloads: ["workflow"] } },
          defaultEnvironment: "default",
        }),
        ".work/package.json": JSON.stringify({
          name: "machines",
          private: true,
          workspaces: ["workflows"],
        }),
        ".work/workflows/package.json": JSON.stringify({
          name: "@project/workflows",
          private: true,
          type: "module",
          dependencies: { "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION },
        }),
        ".work/workflows/src/machines.ts": PROVISIONER,
      },
    },
  );
  expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
  for (const workflowName of ["createMachine", "destroyMachine"]) {
    const request = {
      identity: setup,
      projectId,
      workflowName,
      owner: { type: "project" as const },
    };
    const preview = await core.workflowEnablements.preview(request);
    await core.workflowEnablements.create({
      ...request,
      consentDigest: preview.consentDigest,
    });
  }
}, 180_000);

afterAll(async () => {
  await server?.shutdown();
  // Deployment snapshots in the workflow sandbox are read-only.
  const writable = (dir: string) => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) writable(path.join(dir, entry.name));
  };
  writable(root);
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Runs of one workflow once none is still going. */
async function settledRuns(workflowName: string, count: number) {
  return waitFor(`${count} settled ${workflowName} run(s)`, async () => {
    const runs = await server.catamorphic.core.db
      .selectFrom("workflow_runs")
      .select(["status", "result", "error", "correlation_key"])
      .where("project_id", "=", projectId)
      .where("workflow_name", "=", workflowName)
      .orderBy("created_at")
      .execute();
    return runs.length === count &&
      runs.every((run) => ["completed", "failed"].includes(run.status))
      ? runs
      : undefined;
  });
}

it("creates and destroys machines through the project's own workflows", async () => {
  const core = server.catamorphic.core;
  const registry = new WorkWorkerRegistry({
    db: core.db,
    nodes: new WorkerNodesService(core.db),
    tenantId: SERVER_TENANT_ID,
    authorityId: "machine-workflows-e2e",
  });
  const reconciler = new MachineReconciler({
    db: core.db,
    tenantId: SERVER_TENANT_ID,
    workers: registry,
    classes: {
      fleet: {
        platform: "workflow",
        project: projectId,
        create: "createMachine",
        destroy: "destroyMachine",
        options: { prefix: "i" },
      },
    },
    workflows: new ProjectMachineWorkflows({
      core,
      tenantId: SERVER_TENANT_ID,
    }),
    install: installTarget({
      publicBase: PUBLIC,
      workerImage: "ghcr.io/acme/work-server:test",
    }),
    controlPlaneUrl: PUBLIC,
    emailOf: async () => undefined,
  });
  const machine = async (name: string) =>
    (await registry.machines()).find((candidate) => candidate.name === name);

  await reconciler.setRule({
    name: "fleet",
    rule: { group: ENG, machines: { shared: 1 }, class: "fleet" },
  });
  const name = sharedName("fleet", "fleet", ENG, 1);
  await reconciler.reconcile();
  const [create] = await settledRuns("createMachine", 1);
  expect(create?.status, create?.error ?? "").toBe("completed");
  const pending = await machine(name);
  const key = pending?.ref?.replace("creating:", "") ?? "";
  expect(create?.correlation_key).toBe(`machine-create:${key}`);
  expect(create?.result).toEqual({ ref: `i-${key.slice(0, 8)}` });

  const summary = await reconciler.reconcile();
  expect(summary.created).toEqual([name]);
  expect(await machine(name)).toMatchObject({
    state: "pending",
    ref: `i-${key.slice(0, 8)}`,
  });
  // Another pass starts no second create for the same enrollment.
  await reconciler.reconcile();
  expect(await settledRuns("createMachine", 1)).toHaveLength(1);

  await reconciler.deleteRule("fleet");
  await reconciler.reconcile();
  const [destroy] = await settledRuns("destroyMachine", 1);
  expect(destroy?.result).toEqual({ done: true });
  expect((await reconciler.reconcile()).removed).toEqual([name]);
  expect(await machine(name)).toBeUndefined();

  const events = await core.db
    .selectFrom("project_events")
    .select(["kind", "payload"])
    .where("project_id", "=", projectId)
    .where("source", "=", "machines")
    .orderBy("sequence")
    .execute();
  expect(events).toEqual([
    {
      kind: "machine.created",
      payload: {
        name,
        class: "fleet",
        rule: "fleet",
        ref: `i-${key.slice(0, 8)}`,
      },
    },
    {
      kind: "machine.destroyed",
      payload: {
        name,
        class: "fleet",
        rule: "fleet",
        ref: `i-${key.slice(0, 8)}`,
      },
    },
  ]);
}, 180_000);
