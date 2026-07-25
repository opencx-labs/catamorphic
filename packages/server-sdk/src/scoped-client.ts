import type {
  BatchItemStep,
  CancelRunInput,
  CatamorphicCore,
  WorkflowDetail as CoreWorkflowDetail,
  WorkflowSummary as CoreWorkflowSummary,
  CreateProjectInput,
  GetRunInput,
  Identity,
  ListBatchItemStepsInput,
  ListBatchItemsInput,
  ListBatchItemsResult,
  ListProjectsInput,
  ListProjectsResult,
  ListRunsInput,
  ListRunsResult,
  PauseRunInput,
  Project,
  ProjectFileEntry,
  ResumeRunInput,
  ResumeRunPauseInput,
  Run,
  RunDetail,
  TriggerProductionRunInput,
  TriggerTestRunInput,
  UpdateProjectInput,
  WriteFileInput,
} from "@catamorphic/core";

export type WorkflowSummary = Omit<CoreWorkflowSummary, "execution">;
type PublicWorkflowNode = Omit<
  CoreWorkflowDetail["nodes"][number],
  "workflowTarget"
>;
export type WorkflowDetail = Omit<CoreWorkflowDetail, "execution" | "nodes"> & {
  nodes: PublicWorkflowNode[];
};

export interface ProjectsResource {
  create(args: CreateProjectInput): Promise<Project>;
  list(args: ListProjectsInput): Promise<ListProjectsResult>;
  get(args: { projectId: string }): Promise<Project>;
  update(args: { projectId: string } & UpdateProjectInput): Promise<Project>;
  delete(args: { projectId: string }): Promise<void>;
}

export interface WorkflowsResource {
  list(args: { projectId: string; ref?: string }): Promise<WorkflowSummary[]>;
  get(args: {
    projectId: string;
    workflowName: string;
    ref?: string;
  }): Promise<WorkflowDetail>;
}

export interface FilesResource {
  list(args: { projectId: string }): Promise<ProjectFileEntry[]>;
  read(args: { projectId: string; path: string }): Promise<string>;
  readAll(args: { projectId: string }): Promise<Record<string, string>>;
  write(
    args: { projectId: string; path: string } & WriteFileInput,
  ): Promise<string>;
}

export interface RunsResource {
  triggerProduction(
    args: Omit<TriggerProductionRunInput, "identity">,
  ): Promise<Run>;
  triggerTest(args: Omit<TriggerTestRunInput, "identity">): Promise<Run>;
  list(args: Omit<ListRunsInput, "identity">): Promise<ListRunsResult>;
  get(args: Omit<GetRunInput, "identity">): Promise<RunDetail>;
  cancel(args: Omit<CancelRunInput, "identity">): Promise<Run>;
  pauseProcessing(args: Omit<PauseRunInput, "identity">): Promise<Run>;
  resumeProcessing(args: Omit<ResumeRunInput, "identity">): Promise<Run>;
  submitInput(args: Omit<ResumeRunPauseInput, "identity">): Promise<Run>;
  listItems(
    args: Omit<ListBatchItemsInput, "identity">,
  ): Promise<ListBatchItemsResult>;
  listItemSteps(
    args: Omit<ListBatchItemStepsInput, "identity">,
  ): Promise<BatchItemStep[]>;
}

function buildProjects(
  core: CatamorphicCore,
  identity: Identity,
): ProjectsResource {
  return {
    create: (args) => core.projects.create(identity, args),
    list: (args) => core.projects.list(identity, args),
    get: ({ projectId }) => core.projects.get(identity, projectId),
    update: ({ projectId, ...input }) =>
      core.projects.update(identity, projectId, input),
    delete: ({ projectId }) => core.projects.delete(identity, projectId),
  };
}

function buildWorkflows(
  core: CatamorphicCore,
  identity: Identity,
): WorkflowsResource {
  return {
    list: async (args) =>
      (await core.workflows.list({ ...args, identity })).map(
        toPublicWorkflowSummary,
      ),
    get: async (args) =>
      toPublicWorkflowDetail(await core.workflows.get({ ...args, identity })),
  };
}

function toPublicWorkflowSummary(
  workflow: CoreWorkflowSummary,
): WorkflowSummary {
  const { execution: _execution, ...summary } = workflow;
  return summary;
}

function toPublicWorkflowDetail(workflow: CoreWorkflowDetail): WorkflowDetail {
  const { execution: _execution, nodes, ...detail } = workflow;
  return {
    ...detail,
    nodes: nodes.map(({ workflowTarget: _workflowTarget, ...node }) => node),
  };
}

function buildFiles(core: CatamorphicCore, identity: Identity): FilesResource {
  return {
    list: ({ projectId }) => core.projects.listFiles(identity, projectId),
    read: ({ projectId, path }) =>
      core.projects.readFile(identity, projectId, path),
    readAll: ({ projectId }) => core.projects.readAllFiles(identity, projectId),
    write: ({ projectId, path, ...input }) =>
      core.projects.writeFile(identity, projectId, path, input),
  };
}

function buildRuns(core: CatamorphicCore, identity: Identity): RunsResource {
  return {
    triggerProduction: (args) =>
      core.runs.triggerProduction({ ...args, identity }),
    triggerTest: (args) => core.runs.triggerTest({ ...args, identity }),
    list: (args) => core.runs.list({ ...args, identity }),
    get: (args) => core.runs.get({ ...args, identity }),
    cancel: (args) => core.runs.cancel({ ...args, identity }),
    pauseProcessing: (args) => core.runs.pause({ ...args, identity }),
    resumeProcessing: (args) => core.runs.resume({ ...args, identity }),
    submitInput: (args) => core.runs.resumePause({ ...args, identity }),
    listItems: (args) => core.runs.listItems({ ...args, identity }),
    listItemSteps: (args) => core.runs.listItemSteps({ ...args, identity }),
  };
}

/**
 * Catamorphic client bound to a specific host org + host user. Produced by
 * `Catamorphic#forTenant({ tenantId }).forUser({ externalUserId })`. Every call
 * forwards the identity to the underlying core services; hosts never pass ids
 * inline.
 */
export class ScopedClient {
  readonly projects: ProjectsResource;
  readonly workflows: WorkflowsResource;
  readonly files: FilesResource;
  readonly runs: RunsResource;

  constructor(
    core: CatamorphicCore,
    private readonly identity: Identity,
  ) {
    this.projects = buildProjects(core, identity);
    this.workflows = buildWorkflows(core, identity);
    this.files = buildFiles(core, identity);
    this.runs = buildRuns(core, identity);
  }

  get tenantId(): string {
    return this.identity.tenantId;
  }

  get externalUserId(): string {
    return this.identity.externalUserId;
  }
}

/**
 * Intermediate stage produced by `Catamorphic#forTenant({ tenantId })`. Exists
 * so embedders can bind the tenant once at the edge of their request handler,
 * then bind the user id only once they know which user to act as.
 */
export class TenantScopedClient {
  constructor(
    private readonly core: CatamorphicCore,
    readonly tenantId: string,
  ) {}

  forUser(args: { externalUserId: string }): ScopedClient {
    return new ScopedClient(this.core, {
      tenantId: this.tenantId,
      externalUserId: args.externalUserId,
    });
  }
}
