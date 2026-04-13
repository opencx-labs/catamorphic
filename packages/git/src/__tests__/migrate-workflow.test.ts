import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { migrateWorkflowToProject } from "../migrate-workflow.js";
import { ProjectManager } from "../project-manager.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";

describe("migrateWorkflowToProject", () => {
  let tmpDir: string;
  let manager: ProjectManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-mig-"));
    manager = new ProjectManager(new FsBackend(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a project with the workflow code in src/", async () => {
    const code = `
export async function welcomeUser({ email }: { email: string }) {
  "use workflow";
  await sendEmail({ to: email });
}
`;

    const result = await migrateWorkflowToProject({
      projectManager: manager,
      tenantId: TENANT,
      projectId: PROJECT,
      workflowName: "Welcome User",
      workflowCode: code,
    });

    expect(result.projectId).toBe(PROJECT);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const repo = await manager.open(TENANT, PROJECT);
    const files = await repo.listFiles();
    expect(files.some((f) => f.includes("welcome-user.ts"))).toBe(true);

    const content = await repo.readFile("src/welcome-user.ts");
    expect(content).toContain("use workflow");

    await repo.dispose();
  });

  it("sanitizes workflow name for filename", async () => {
    const result = await migrateWorkflowToProject({
      projectManager: manager,
      tenantId: TENANT,
      projectId: PROJECT,
      workflowName: "My Special Workflow!",
      workflowCode: 'export async function f() { "use workflow"; }',
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const repo = await manager.open(TENANT, PROJECT);
    const files = await repo.listFiles();
    expect(files.some((f) => f.includes("my-special-workflow-"))).toBe(true);

    await repo.dispose();
  });
});
