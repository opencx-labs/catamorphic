import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { expect, it } from "vitest";
import type { ProjectsService } from "../services/projects-service.js";
import { WorkflowsService } from "../services/workflows-service.js";

it("workflow graph reads exclude large media and other repositories before loading contents", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cat-workflow-sources-"),
  );
  const manager = new ProjectManager(new FsBackend(root));
  const identity = {
    tenantId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    externalUserId: "user",
  };
  const repo = await manager.create(
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "f1e2d3c4-b5a6-7890-dcba-fedcba987654",
    {
      name: "parent-directory",
    },
  );
  try {
    await repo.writeFile(
      "workflows/main.ts",
      `import { defineWorkflow } from "@catamorphic/workflow";
      export const example = defineWorkflow(({ defineBoundary }) => ({ steps: [defineBoundary({ run: () => "ok" })] }));`,
    );
    await repo.writeFile("nested/.git/HEAD", "ref: refs/heads/main");
    await repo.writeFile(
      "nested/workflows/unrelated.ts",
      "export const unrelated = 1;",
    );
    const video = await fs.open(path.join(repo.repoPath, "video.mp4"), "w");
    await video.truncate(256 * 1024 * 1024);
    await video.close();
    const projects = {
      getOverview: async () => ({ id: "f1e2d3c4-b5a6-7890-dcba-fedcba987654" }),
    } as unknown as ProjectsService;
    // Read the exact working copy written above, without a database or server.
    const scopedManager = {
      openDev: async () => repo,
    } as unknown as ProjectManager;
    const service = new WorkflowsService(scopedManager, projects);
    const listed = await service.list({
      identity,
      projectId: "f1e2d3c4-b5a6-7890-dcba-fedcba987654",
    });
    expect(listed.map((workflow) => workflow.name)).toEqual(["example"]);
    const detail = await service.get({
      identity,
      projectId: "f1e2d3c4-b5a6-7890-dcba-fedcba987654",
      workflowName: "example",
    });
    expect(detail.allFiles["workflows/main.ts"]).toContain("defineWorkflow");
    expect(detail.allFiles["video.mp4"]).toBeUndefined();
    expect(detail.allFiles["nested/workflows/unrelated.ts"]).toBeUndefined();
    expect(JSON.stringify(detail).length).toBeLessThan(20_000);
  } finally {
    await repo.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
