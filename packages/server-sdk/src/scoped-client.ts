import type {
  CatamorphicCore,
  CreateProjectInput,
  Identity,
  ListProjectsInput,
  ListProjectsResult,
  Project,
  ProjectFileEntry,
  UpdateProjectInput,
  WorkflowDetail,
  WorkflowSummary,
  WriteFileInput,
} from "@catamorphic/core";

export interface ProjectsResource {
  create(input: CreateProjectInput): Promise<Project>;
  list(input?: ListProjectsInput): Promise<ListProjectsResult>;
  get(projectId: string): Promise<Project>;
  update(projectId: string, input: UpdateProjectInput): Promise<Project>;
  delete(projectId: string): Promise<void>;
}

export interface WorkflowsResource {
  list(projectId: string): Promise<WorkflowSummary[]>;
  get(
    projectId: string,
    workflowName: string,
    opts?: { ref?: string },
  ): Promise<WorkflowDetail>;
}

export interface FilesResource {
  list(projectId: string): Promise<ProjectFileEntry[]>;
  read(projectId: string, path: string): Promise<string>;
  readAll(projectId: string): Promise<Record<string, string>>;
  write(
    projectId: string,
    path: string,
    input: WriteFileInput,
  ): Promise<string>;
}

function buildProjects(
  core: CatamorphicCore,
  identity: Identity,
): ProjectsResource {
  return {
    create: (input) => core.projects.create(identity, input),
    list: (input) => core.projects.list(identity, input),
    get: (projectId) => core.projects.get(identity, projectId),
    update: (projectId, input) =>
      core.projects.update(identity, projectId, input),
    delete: (projectId) => core.projects.delete(identity, projectId),
  };
}

function buildWorkflows(
  core: CatamorphicCore,
  identity: Identity,
): WorkflowsResource {
  return {
    list: (projectId) => core.workflows.list(identity, projectId),
    get: (projectId, workflowName, opts) =>
      core.workflows.get(identity, projectId, workflowName, opts),
  };
}

function buildFiles(core: CatamorphicCore, identity: Identity): FilesResource {
  return {
    list: (projectId) => core.projects.listFiles(identity, projectId),
    read: (projectId, path) =>
      core.projects.readFile(identity, projectId, path),
    readAll: (projectId) => core.projects.readAllFiles(identity, projectId),
    write: (projectId, path, input) =>
      core.projects.writeFile(identity, projectId, path, input),
  };
}

/**
 * Catamorphic client bound to a specific host org + host user. Produced by
 * `Catamorphic#forTenant(orgId).forUser(userId)`. Every call forwards the
 * identity to the underlying core services — hosts never pass ids inline.
 */
export class ScopedClient {
  readonly projects: ProjectsResource;
  readonly workflows: WorkflowsResource;
  readonly files: FilesResource;

  constructor(
    core: CatamorphicCore,
    private readonly identity: Identity,
  ) {
    this.projects = buildProjects(core, identity);
    this.workflows = buildWorkflows(core, identity);
    this.files = buildFiles(core, identity);
  }

  get tenantId(): string {
    return this.identity.tenantId;
  }

  get externalUserId(): string {
    return this.identity.externalUserId;
  }
}

/**
 * Intermediate stage produced by `Catamorphic#forTenant(tenantId)`. Exists so
 * embedders can bind the tenant once at the edge of their request handler,
 * then bind the user id only once they actually know which user to act as.
 */
export class TenantScopedClient {
  constructor(
    private readonly core: CatamorphicCore,
    readonly tenantId: string,
  ) {}

  forUser(externalUserId: string): ScopedClient {
    return new ScopedClient(this.core, {
      tenantId: this.tenantId,
      externalUserId,
    });
  }
}
