import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import { Catamorphic } from "./catamorphic.js";
import { ScopedClient } from "./scoped-client.js";

const identity: Identity = {
  tenantId: "tenant-1",
  externalUserId: "user-1",
};

function createCoreMock() {
  const projects = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    readAllFiles: vi.fn(),
    writeFile: vi.fn(),
  };
  const workflows = {
    list: vi.fn(),
    get: vi.fn(),
  };
  const runs = {
    triggerProduction: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    resumePause: vi.fn(),
    listItems: vi.fn(),
    listItemSteps: vi.fn(),
    startWorker: vi.fn(),
    redriveJob: vi.fn(),
  };
  const core = {
    projects,
    workflows,
    runs,
  } as unknown as CatamorphicCore;
  return { core, projects, workflows, runs };
}

describe("ScopedClient", () => {
  it("forwards keyed project, workflow, and file parameters", async () => {
    const { core, projects, workflows } = createCoreMock();
    workflows.list.mockResolvedValue([]);
    workflows.get.mockResolvedValue({
      execution: {
        exportTarget: { modulePath: "src/index.ts", exportName: "sendEmail" },
        steps: [],
      },
      nodes: [],
    });
    const scoped = new ScopedClient(core, identity);

    void scoped.projects.create({ name: "Project" });
    void scoped.projects.list({ limit: 10, offset: 20 });
    void scoped.projects.get({ projectId: "project-1" });
    void scoped.projects.update({ projectId: "project-1", name: "Renamed" });
    void scoped.projects.delete({ projectId: "project-1" });
    await scoped.workflows.list({
      projectId: "project-1",
      ref: "origin/main",
    });
    await scoped.workflows.get({
      projectId: "project-1",
      workflowName: "sendEmail",
      ref: "origin/main",
    });
    void scoped.files.list({ projectId: "project-1" });
    void scoped.files.read({ projectId: "project-1", path: "src/index.ts" });
    void scoped.files.readAll({ projectId: "project-1" });
    void scoped.files.write({
      projectId: "project-1",
      path: "src/index.ts",
      content: "export {};",
      commitMessage: "Write file",
    });

    expect(projects.create).toHaveBeenCalledWith(identity, {
      name: "Project",
    });
    expect(projects.list).toHaveBeenCalledWith(identity, {
      limit: 10,
      offset: 20,
    });
    expect(projects.get).toHaveBeenCalledWith(identity, "project-1");
    expect(projects.update).toHaveBeenCalledWith(identity, "project-1", {
      name: "Renamed",
    });
    expect(projects.delete).toHaveBeenCalledWith(identity, "project-1");
    expect(workflows.list).toHaveBeenCalledWith({
      identity,
      projectId: "project-1",
      ref: "origin/main",
    });
    expect(workflows.get).toHaveBeenCalledWith({
      identity,
      projectId: "project-1",
      workflowName: "sendEmail",
      ref: "origin/main",
    });
    expect(projects.listFiles).toHaveBeenCalledWith(identity, "project-1");
    expect(projects.readFile).toHaveBeenCalledWith(
      identity,
      "project-1",
      "src/index.ts",
    );
    expect(projects.readAllFiles).toHaveBeenCalledWith(identity, "project-1");
    expect(projects.writeFile).toHaveBeenCalledWith(
      identity,
      "project-1",
      "src/index.ts",
      { content: "export {};", commitMessage: "Write file" },
    );
  });

  it("removes internal execution descriptors from public workflow DTOs", async () => {
    const { core, workflows } = createCoreMock();
    workflows.list.mockResolvedValue([
      {
        name: "sendEmail",
        execution: {
          exportTarget: {
            modulePath: "src/index.ts",
            exportName: "sendEmail",
          },
          steps: [],
        },
      },
    ]);
    workflows.get.mockResolvedValue({
      name: "sendEmail",
      execution: {
        exportTarget: {
          modulePath: "src/index.ts",
          exportName: "sendEmail",
        },
        steps: [],
      },
      nodes: [
        {
          id: "call",
          workflowTarget: {
            execution: {
              exportTarget: {
                modulePath: "src/child.ts",
                exportName: "child",
              },
              steps: [],
            },
          },
        },
      ],
    });
    const scoped = new ScopedClient(core, identity);

    const summaries = await scoped.workflows.list({ projectId: "project-1" });
    const detail = await scoped.workflows.get({
      projectId: "project-1",
      workflowName: "sendEmail",
    });

    expect(summaries[0]).not.toHaveProperty("execution");
    expect(detail).not.toHaveProperty("execution");
    expect(detail.nodes[0]).not.toHaveProperty("workflowTarget");
  });
});

describe("Catamorphic execution lifecycle", () => {
  it("delegates worker startup and redrive through core.runs", async () => {
    const { core, runs } = createCoreMock();
    let finishWorker: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    const stop = vi.fn(async () => finishWorker?.());
    runs.startWorker.mockReturnValue({
      id: "worker-1",
      name: "host-worker",
      done,
      stop,
    });
    runs.redriveJob.mockResolvedValue(true);
    Object.defineProperty(core, "sandboxProvider", { value: {} });
    const catamorphic = new Catamorphic({ core });

    const handle = catamorphic.startExecutionWorker({
      name: "host-worker",
      concurrency: 4,
    });
    const redriven = await catamorphic.redriveExecutionJob({
      tenantId: "tenant-1",
      jobId: "job-1",
    });
    await catamorphic.close();

    expect(handle.id).toBe("worker-1");
    expect(runs.startWorker).toHaveBeenCalledWith({
      name: "host-worker",
      concurrency: 4,
    });
    expect(runs.redriveJob).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      jobId: "job-1",
    });
    expect(redriven).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("binds identity with keyed objects", () => {
    const { core } = createCoreMock();
    const catamorphic = new Catamorphic({ core });

    const scoped = catamorphic
      .forTenant({ tenantId: "tenant-1" })
      .forUser({ externalUserId: "user-1" });

    expect(scoped.tenantId).toBe("tenant-1");
    expect(scoped.externalUserId).toBe("user-1");
  });
});
