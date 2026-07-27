import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import {
  type DeclaredSecret,
  layoutGraph,
  parseProject,
  parseWorkflowFromProject,
  type WorkflowCapabilities,
  type WorkflowExecutionDescriptor,
  type WorkflowGraph,
} from "@catamorphic/parser";
import type { Identity } from "../identity.js";
import { assertProjectSurface } from "./app-audience.js";
import {
  ProjectNotFoundError,
  type ProjectsService,
} from "./projects-service.js";

export interface WorkflowSummary {
  name: string;
  capabilities: WorkflowCapabilities;
  execution: WorkflowExecutionDescriptor;
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
 * not separate DB entities; the exported TypeScript source is the registry.
 */
export class WorkflowsService {
  constructor(
    private readonly projectManager: ProjectManager,
    private readonly projects: ProjectsService,
  ) {}

  async list(args: {
    identity: Identity;
    projectId: string;
    ref?: string;
  }): Promise<WorkflowSummary[]> {
    await this.requireProject(args.identity, args.projectId);
    return this.withDev(args.identity, args.projectId, async (repo) => {
      const files = args.ref
        ? await repo.readAllFilesAtRef(args.ref)
        : await repo.readAllFiles();
      const { workflows } = parseProject(files);
      return workflows.map((wf) => ({
        name: wf.functionName,
        capabilities: wf.graph.capabilities,
        execution: wf.graph.execution,
        displayName: wf.graph.displayName ?? null,
        description: wf.graph.description ?? null,
        filePath: wf.filePath ?? "",
        parameterCount: wf.graph.trigger.parameters.length,
      }));
    });
  }

  async get(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    ref?: string;
  }): Promise<WorkflowDetail> {
    await this.requireProject(args.identity, args.projectId);
    return this.withDev(args.identity, args.projectId, async (repo) => {
      const allFiles = args.ref
        ? await repo.readAllFilesAtRef(args.ref)
        : await repo.readAllFiles();
      const graph = parseWorkflowFromProject(allFiles, args.workflowName);
      if (!graph) {
        throw new WorkflowNotFoundError(args.projectId, args.workflowName);
      }

      layoutGraph({ nodes: graph.nodes, edges: graph.edges });

      return {
        ...graph,
        projectFiles: Object.keys(allFiles),
        allFiles,
      };
    });
  }

  /** Secrets the project declares in its own code via `defineSecrets`. */
  async listDeclaredSecrets(args: {
    identity: Identity;
    projectId: string;
    ref?: string;
  }): Promise<DeclaredSecret[]> {
    await this.requireProject(args.identity, args.projectId);
    return this.withDev(args.identity, args.projectId, async (repo) => {
      const files = args.ref
        ? await repo.readAllFilesAtRef(args.ref)
        : await repo.readAllFiles();
      return parseProject(files).secrets;
    });
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    assertProjectSurface(identity);
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
