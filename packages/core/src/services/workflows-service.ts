import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import {
  layoutGraph,
  parseProject,
  parseWorkflowFromProject,
  type WorkflowGraph,
} from "@catamorphic/parser";
import type { Identity } from "../identity.js";
import {
  ProjectNotFoundError,
  type ProjectsService,
} from "./projects-service.js";

export interface WorkflowSummary {
  name: string;
  kind: "regular" | "batch";
  displayName: string | null;
  description: string | null;
  filePath: string;
  parameterCount: number;
}

export interface WorkflowDetail extends WorkflowGraph {
  projectFiles: string[];
  allFiles: Record<string, string>;
}

export class WorkflowNotFoundError extends Error {
  constructor(
    readonly projectId: string,
    readonly workflowName: string,
  ) {
    super(`Workflow '${workflowName}' not found in project '${projectId}'`);
    this.name = "WorkflowNotFoundError";
  }
}

/**
 * Reads workflow definitions by parsing project source files. Workflows are
 * not separate DB entities — they are exported functions with a
 * `"use workflow"` directive in the project's git repo.
 */
export class WorkflowsService {
  constructor(
    private readonly projectManager: ProjectManager,
    private readonly projects: ProjectsService,
  ) {}

  async list(
    identity: Identity,
    projectId: string,
  ): Promise<WorkflowSummary[]> {
    await this.requireProject(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      const files = await repo.readAllFiles();
      const { workflows } = parseProject(files);
      return workflows.map((wf) => ({
        name: wf.functionName,
        kind: wf.kind ?? "regular",
        displayName: wf.graph.displayName ?? null,
        description: wf.graph.description ?? null,
        filePath: wf.filePath ?? "",
        parameterCount: wf.graph.trigger.parameters.length,
      }));
    });
  }

  async get(
    identity: Identity,
    projectId: string,
    workflowName: string,
    opts: { ref?: string } = {},
  ): Promise<WorkflowDetail> {
    await this.requireProject(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      const allFiles = opts.ref
        ? await repo.readAllFilesAtRef(opts.ref)
        : await repo.readAllFiles();
      const graph = parseWorkflowFromProject(allFiles, workflowName);
      if (!graph) throw new WorkflowNotFoundError(projectId, workflowName);

      layoutGraph({ nodes: graph.nodes, edges: graph.edges });

      return {
        ...graph,
        projectFiles: Object.keys(allFiles),
        allFiles,
      };
    });
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    // Delegates to ProjectsService so "project exists" logic lives in one place.
    try {
      await this.projects.get(identity, projectId);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw err;
      throw err;
    }
  }

  private async withDev<T>(
    identity: Identity,
    projectId: string,
    fn: (repo: ProjectRepo) => Promise<T>,
  ): Promise<T> {
    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return await fn(repo);
    } finally {
      await repo.dispose();
    }
  }
}
