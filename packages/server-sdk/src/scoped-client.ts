import type {
  BatchItemStep,
  CancelRunInput,
  CatamorphicCore,
  WorkflowDetail as CoreWorkflowDetail,
  WorkflowSummary as CoreWorkflowSummary,
  CreateProjectInput,
  GetRunInput,
  GithubConnectionStatus,
  Identity,
  ImportGithubRepoInput,
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
import type { Json } from "@catamorphic/db";
import type { GithubRepo, GithubTokenSet } from "@catamorphic/github";

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

/**
 * GitHub connection + import surface. Unavailable (methods throw) unless the
 * host configured `github` on `createCatamorphic`. Token acquisition is
 * host-owned: obtain a `GithubTokenSet` via the device flow or web flow
 * helpers in `@catamorphic/github`, then hand it to `connect`.
 */
export interface GithubResource {
  status(): Promise<GithubConnectionStatus>;
  connect(args: { tokens: GithubTokenSet }): Promise<GithubConnectionStatus>;
  connectWithCode(args: {
    code: string;
    redirectUri?: string;
  }): Promise<GithubConnectionStatus>;
  disconnect(): Promise<void>;
  listRepos(): Promise<GithubRepo[]>;
  importRepo(args: ImportGithubRepoInput): Promise<Project>;
  pushProject(args: { projectId: string }): Promise<void>;
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
  /** Delivers an external event to the run awaiting a named signal for a key. */
  signalByKey(args: {
    projectId: string;
    workflowName: string;
    correlationKey: string;
    signal: string;
    idempotencyKey: string;
    value: Json;
  }): Promise<Run>;
  /** Terminates the live run for a key. Resolves null when none was live. */
  cancelByKey(args: {
    projectId: string;
    workflowName: string;
    correlationKey: string;
    reason?: string;
  }): Promise<Run | null>;
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

function buildGithub(
  core: CatamorphicCore,
  identity: Identity,
): GithubResource {
  const github = () => {
    if (!core.github) {
      throw new Error(
        "GitHub integration not configured — pass `github` to createCatamorphic",
      );
    }
    return core.github;
  };
  return {
    status: () => github().status(identity),
    connect: ({ tokens }) => github().connect(identity, tokens),
    connectWithCode: (args) => github().connectWithCode(identity, args),
    disconnect: () => github().disconnect(identity),
    listRepos: () => github().listRepos(identity),
    importRepo: (args) => github().importRepo(identity, args),
    pushProject: ({ projectId }) => github().pushProject(identity, projectId),
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
    signalByKey: (args) => core.runs.signalByKey({ ...args, identity }),
    cancelByKey: (args) => core.runs.cancelByKey({ ...args, identity }),
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
  readonly github: GithubResource;

  constructor(
    core: CatamorphicCore,
    private readonly identity: Identity,
  ) {
    this.projects = buildProjects(core, identity);
    this.workflows = buildWorkflows(core, identity);
    this.files = buildFiles(core, identity);
    this.runs = buildRuns(core, identity);
    this.github = buildGithub(core, identity);
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
