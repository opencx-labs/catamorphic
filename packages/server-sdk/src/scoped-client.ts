import type {
  ArtifactRef,
  BatchItemStep,
  CallRunInput,
  CancelRunInput,
  CatamorphicCore,
  WorkflowDetail as CoreWorkflowDetail,
  WorkflowSummary as CoreWorkflowSummary,
  CreateProjectInput,
  EnrollmentConflictPolicy,
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
  RunCallOutcome,
  RunDetail,
  TriggerBindingInfo,
  TriggerFireResult,
  TriggerKindInfo,
  TriggerMode,
  TriggerProductionRunInput,
  UpdateProjectInput,
  WorkflowEnablement,
  WorkflowEnablementOwner,
  WorkflowEnablementPreview,
  WriteFileInput,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import type { GithubRepo, GithubTokenSet } from "@catamorphic/github";
import type { TriggerKindDefinition } from "./define-trigger-kind.js";

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

export interface WorkflowEnablementsResource {
  preview(args: {
    projectId: string;
    workflowName: string;
    environment?: string;
    owner?: WorkflowEnablementOwner;
    connectionSelections?: Readonly<Record<string, string>>;
    commitSha?: string;
    remoteBranch?: string;
  }): Promise<WorkflowEnablementPreview>;
  create(args: {
    projectId: string;
    workflowName: string;
    environment?: string;
    owner?: WorkflowEnablementOwner;
    connectionSelections?: Readonly<Record<string, string>>;
    commitSha?: string;
    remoteBranch?: string;
    consentDigest: string;
    temporary?: boolean;
    expiresAt?: Date;
  }): Promise<WorkflowEnablement>;
  list(args: {
    projectId: string;
    workflowName?: string;
    includeAll?: boolean;
  }): Promise<WorkflowEnablement[]>;
  get(args: { enablementId: string }): Promise<WorkflowEnablement>;
  disable(args: { enablementId: string }): Promise<WorkflowEnablement>;
  reenable(args: { enablementId: string }): Promise<WorkflowEnablement>;
  updateDeployment(args: {
    enablementId: string;
    consentDigest: string;
  }): Promise<WorkflowEnablement>;
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
  /**
   * Triggers a run and drives it inline until it settles or reaches a
   * durable wait — the request-path shape of execution. Same authorization
   * and durable run record as `triggerProduction`; a `suspended` outcome
   * carries the run id for `get` polling.
   */
  call(args: Omit<CallRunInput, "identity">): Promise<RunCallOutcome>;
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

/** A trigger kind reference: the typed definition value, or its bare name. */
export type TriggerKindRef<Payload = Json, Config = Json> =
  | TriggerKindDefinition<Payload, Config>
  | string;

/**
 * Custom trigger surface. Fire a host-defined kind with a payload and every
 * workflow bound to it at the production commit runs; pass the
 * `defineTriggerKind` value as `kind` and the payload/config types flow
 * through. Sync firings return settled outcomes, detaching to the queue —
 * with an honest `suspended` outcome — at the first durable wait; check
 * `canSuspend` on a binding for the workflows where that can happen.
 */
export interface TriggersResource {
  /** The host's registered kinds, as static metadata. */
  kinds(): TriggerKindInfo[];
  list<Config = Json>(args: {
    projectId: string;
    kind?: TriggerKindRef<Json, Config>;
  }): Promise<Array<Omit<TriggerBindingInfo, "config"> & { config: Config }>>;
  fire<Payload = Json>(args: {
    projectId: string;
    kind: TriggerKindRef<Payload, Json>;
    payload: Payload;
    /** Defaults to async. */
    mode?: TriggerMode;
    /** Restrict to these bound workflows (e.g. the one tool the AI called). */
    workflows?: readonly string[];
    correlationKey?: string;
    onConflict?: EnrollmentConflictPolicy;
    /** Sync only: wall-clock budget before detaching. Defaults to 30s. */
    budgetMs?: number;
  }): Promise<TriggerFireResult>;
  /**
   * Writes the generated `catamorphic-triggers.d.ts` into the project's dev
   * tree when drifted from the registered kinds.
   */
  syncTypes(args: {
    projectId: string;
  }): Promise<{ paths: string[]; updated: boolean }>;
}

function kindName(kind: TriggerKindRef<unknown, unknown>): string {
  return typeof kind === "string" ? kind : kind.name;
}

function buildTriggers(
  core: CatamorphicCore,
  identity: Identity,
): TriggersResource {
  return {
    kinds: () => core.triggers.listKinds(),
    list: async (args) =>
      (await core.triggers.list({
        identity,
        projectId: args.projectId,
        kind: args.kind === undefined ? undefined : kindName(args.kind),
      })) as never,
    fire: (args) =>
      core.triggers.fire({
        identity,
        projectId: args.projectId,
        kind: kindName(args.kind),
        payload: args.payload as Json,
        mode: args.mode,
        workflows: args.workflows,
        correlationKey: args.correlationKey,
        onConflict: args.onConflict,
        budgetMs: args.budgetMs,
      }),
    syncTypes: (args) =>
      core.triggers.syncTypes({ identity, projectId: args.projectId }),
  };
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
    call: (args) => core.runs.call({ ...args, identity }),
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

function buildWorkflowEnablements(
  core: CatamorphicCore,
  identity: Identity,
): WorkflowEnablementsResource {
  return {
    preview: (args) => core.workflowEnablements.preview({ ...args, identity }),
    create: (args) => core.workflowEnablements.create({ ...args, identity }),
    list: (args) => core.workflowEnablements.list({ ...args, identity }),
    get: (args) => core.workflowEnablements.get({ ...args, identity }),
    disable: (args) => core.workflowEnablements.disable({ ...args, identity }),
    reenable: (args) =>
      core.workflowEnablements.reenable({ ...args, identity }),
    updateDeployment: (args) =>
      core.workflowEnablements.updateDeployment({ ...args, identity }),
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
  readonly workflowEnablements: WorkflowEnablementsResource;
  readonly files: FilesResource;
  readonly runs: RunsResource;
  readonly triggers: TriggersResource;
  readonly github: GithubResource;

  constructor(
    core: CatamorphicCore,
    private readonly identity: Identity,
  ) {
    this.projects = buildProjects(core, identity);
    this.workflows = buildWorkflows(core, identity);
    this.workflowEnablements = buildWorkflowEnablements(core, identity);
    this.files = buildFiles(core, identity);
    this.runs = buildRuns(core, identity);
    this.triggers = buildTriggers(core, identity);
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

  /**
   * Binds the user. Omit `scope` for a builder (full project surface); pass
   * the artifacts a viewer is entitled to — an app, a workflow — for a
   * scoped identity that can reach exactly those (ADR 0053).
   */
  forUser(args: {
    externalUserId: string;
    scope?: readonly ArtifactRef[];
  }): ScopedClient {
    return new ScopedClient(this.core, {
      tenantId: this.tenantId,
      externalUserId: args.externalUserId,
      ...(args.scope === undefined ? {} : { scope: args.scope }),
    });
  }
}
