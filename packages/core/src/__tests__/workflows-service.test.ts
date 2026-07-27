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

describe("WorkflowsService.listDeclaredSecrets", () => {
  const secretFiles = (description: string) => ({
    "workflows/src/secrets.ts": `
      import { defineSecrets } from "@catamorphic/workflow";
      export const secrets = defineSecrets({
        STRIPE_API_KEY: { description: "${description}" },
      });
    `,
  });

  function makeService(files: () => Record<string, string>) {
    const readAllFiles = vi.fn(async () => files());
    const repo = {
      readAllFiles,
      readAllFilesAtRef: vi.fn(async () => files()),
      dispose: vi.fn(async () => {}),
    } as unknown as ProjectRepo;
    const projectManager = {
      openDev: vi.fn(async () => repo),
    } as unknown as ProjectManager;
    const projects = {
      get: vi.fn(async () => ({ id: "project-1" })),
    } as unknown as ProjectsService;
    return {
      service: new WorkflowsService(projectManager, projects),
      readAllFiles,
    };
  }

  it("reads declared secrets from source", async () => {
    const { service } = makeService(() => secretFiles("Stripe key"));
    const secrets = await service.listDeclaredSecrets({
      identity,
      projectId: "project-1",
    });
    expect(secrets.map((secret) => secret.name)).toEqual(["STRIPE_API_KEY"]);
    expect(secrets[0]?.description).toBe("Stripe key");
  });

  it("reuses the parse for unchanged sources", async () => {
    // This runs on every run trigger, so the ts-morph parse must not repeat
    // for an unchanged tree.
    const { service, readAllFiles } = makeService(() =>
      secretFiles("Stripe key"),
    );
    const first = await service.listDeclaredSecrets({
      identity,
      projectId: "project-1",
    });
    const second = await service.listDeclaredSecrets({
      identity,
      projectId: "project-1",
    });
    // Same parsed instance: the cache answered rather than re-parsing.
    expect(second).toBe(first);
    // The repo is still read each time — only the parse is memoized.
    expect(readAllFiles).toHaveBeenCalledTimes(2);
  });

  it("re-parses when a source file changes", async () => {
    let description = "Stripe key";
    const { service } = makeService(() => secretFiles(description));
    const first = await service.listDeclaredSecrets({
      identity,
      projectId: "project-1",
    });
    description = "Rotated Stripe key";
    const second = await service.listDeclaredSecrets({
      identity,
      projectId: "project-1",
    });
    expect(second).not.toBe(first);
    expect(second[0]?.description).toBe("Rotated Stripe key");
  });
});
