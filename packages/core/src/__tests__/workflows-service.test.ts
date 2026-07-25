import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import { describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import type { ProjectsService } from "../services/projects-service.js";
import { WorkflowsService } from "../services/workflows-service.js";

const identity: Identity = {
  tenantId: "tenant-1",
  externalUserId: "user-1",
};

const currentFiles = {
  "src/workflows.ts": `
    export async function currentWorkflow() {
      "use workflow";
      return "current";
    }
  `,
};

const referencedFiles = {
  "src/workflows.ts": `
    export async function referencedWorkflow() {
      "use workflow";
      return "referenced";
    }
  `,
};

describe("WorkflowsService", () => {
  it("lists workflows from the requested git ref", async () => {
    const readAllFiles = vi.fn(async () => currentFiles);
    const readAllFilesAtRef = vi.fn(async () => referencedFiles);
    const dispose = vi.fn(async () => {});
    const repo = {
      readAllFiles,
      readAllFilesAtRef,
      dispose,
    } as unknown as ProjectRepo;
    const projectManager = {
      openDev: vi.fn(async () => repo),
    } as unknown as ProjectManager;
    const projects = {
      get: vi.fn(async () => ({ id: "project-1" })),
    } as unknown as ProjectsService;
    const service = new WorkflowsService(projectManager, projects);

    const workflows = await service.list({
      identity,
      projectId: "project-1",
      ref: "origin/main",
    });

    expect(workflows.map((workflow) => workflow.name)).toEqual([
      "referencedWorkflow",
    ]);
    expect(readAllFilesAtRef).toHaveBeenCalledWith("origin/main");
    expect(readAllFiles).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
