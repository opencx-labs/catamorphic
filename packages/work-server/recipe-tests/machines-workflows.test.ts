import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { expect, it } from "vitest";
import { workflowMachines } from "../../registry/src/machines-workflows/machines-workflows.js";
import { createWorkServer, SERVER_TENANT_ID } from "../src/server.js";
import { createTestDatabase, testServerOptions } from "../src/test-support.js";

const workflow = `
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

/** @displayname Create worker */
export const createWorker = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    /** @displayname Return a stable infrastructure reference */
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ name: string; enrollment: { idempotencyKey: string } }>) =>
        ({ ref: input.name + "-" + input.enrollment.idempotencyKey }),
    }),
  ],
}));

/** @displayname Destroy worker */
export const destroyWorker = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    /** @displayname Confirm destruction */
    defineBoundary({ run: async () => ({ done: true }) }),
  ],
}));
`;

// Workflow deployment snapshots inside local sandboxes are read-only.
async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
}

it.skipIf(!process.env.DATABASE_URL)(
  "enrolls real project workflows once per machine operation through the public SDK",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "work-machines-workflows-"));
    const database = await createTestDatabase("work_machines_workflows");
    const server = await createWorkServer(
      testServerOptions({
        dataDir: root,
        publicBases: ["https://machines-workflows.example.test"],
        env: {
          DATABASE_URL: database.url,
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          PATH: process.env.PATH,
          WORK_SECRET: "local-machines-workflows-test-secret",
          WORK_OPERATOR_SECRET: "local-machines-workflows-operator-secret",
          WORK_VAULT_KEY: Buffer.alloc(32, 18).toString("base64"),
        },
      }),
    );
    try {
      const tenant = server.catamorphic.forTenant({
        tenantId: SERVER_TENANT_ID,
      });
      const externalUserId = "machine-workflows-host";
      const client = tenant.forUser({ externalUserId });
      const project = await client.projects.create({ name: "Infrastructure" });
      const deployment = await server.catamorphic.core.deployment.deploy(
        SERVER_TENANT_ID,
        project.id,
        externalUserId,
        {
          message: "Add infrastructure workflows",
          files: {
            ".work/project.json": JSON.stringify({
              environments: { default: { workloads: ["workflow"] } },
              defaultEnvironment: "default",
            }),
            ".work/package.json": JSON.stringify({
              name: "infrastructure",
              private: true,
              workspaces: ["workflows"],
            }),
            ".work/workflows/package.json": JSON.stringify({
              name: "@project/workflows",
              private: true,
              type: "module",
              dependencies: {
                "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
              },
            }),
            ".work/workflows/src/machines.ts": workflow,
          },
        },
      );
      expect(deployment.status, JSON.stringify(deployment)).toBe("deployed");

      async function enable(workflowName: string) {
        const request = {
          projectId: project.id,
          workflowName,
          owner: { type: "project" as const },
        };
        const preview = await client.workflowEnablements.preview(request);
        const enabled = await client.workflowEnablements.create({
          ...request,
          consentDigest: preview.consentDigest,
        });
        return { name: workflowName, enablementId: enabled.id };
      }

      const provisioner = workflowMachines({
        client,
        projectId: project.id,
        create: await enable("createWorker"),
        destroy: await enable("destroyWorker"),
      });
      const idempotencyKey = randomUUID();
      const request = {
        name: "desk",
        labels: {},
        options: {},
        enrollment: {
          controlPlaneUrl: "https://machines-workflows.example.test",
          code: "wke_fake",
          idempotencyKey,
        },
      };
      const ref = `desk-${idempotencyKey}`;
      await Promise.all([
        provisioner.create(request),
        provisioner.create(request),
      ]);
      const listCreate = () =>
        client.runs.list({
          projectId: project.id,
          workflowName: "createWorker",
        });
      await expect
        .poll(async () => (await listCreate()).items[0]?.status, {
          timeout: 30_000,
        })
        .toMatch(/^(completed|failed|canceled)$/);
      const runs = await listCreate();
      expect(
        runs.items[0]?.status,
        runs.items[0]?.error ?? "Workflow did not complete",
      ).toBe("completed");
      await expect(provisioner.create(request)).resolves.toEqual({ ref });
      expect(runs.total).toBe(1);
      expect(runs.items[0]?.initiatedBy).toBe("catamorphic:project");

      const target = {
        name: "desk",
        ref,
        labels: {},
        options: {},
        idempotencyKey,
        requestedAt: new Date().toISOString(),
      };
      await expect
        .poll(() => provisioner.destroy(target), { timeout: 30_000 })
        .toEqual({ done: true });
      await expect(provisioner.destroy(target)).resolves.toEqual({
        done: true,
      });
      expect(
        (
          await client.runs.list({
            projectId: project.id,
            workflowName: "destroyWorker",
          })
        ).total,
      ).toBe(1);
    } finally {
      await server.shutdown();
      await database.drop();
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
