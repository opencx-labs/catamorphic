import type { DB, Json } from "@catamorphic/db";
import { fetchRemote, type ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  appApiTypesPath,
  appWorkspaceNames,
  holeSchemaErrors,
  matchesAllWhere,
  type ParameterInfo,
  type ProjectTriggerKind,
  parseProject,
  renderAppApiTypesModule,
  resolveTriggerBinding,
} from "@catamorphic/parser";
import {
  PROJECT_CHECK_SCRIPT_PATH,
  PROJECT_WORKFLOWS_PACKAGE_PATH,
  publishedRef,
} from "@catamorphic/workflow/project-layout";
import type { Kysely } from "kysely";
import {
  hasProjectPermission,
  type Identity,
  SYSTEM_AUTHOR,
} from "../identity.js";
import { PROJECT_CHECK_SCRIPT } from "../seeds.js";
import { webhookConfig, webhookSettingsKey } from "../webhook-ingress.js";
import { assertProjectPermission, resolveScope } from "./artifact-scope.js";
import { requireTenantProject } from "./projects-service.js";
import type {
  EnrollmentConflictPolicy,
  RunSuspensionReason,
  RunsService,
} from "./runs-service.js";
import {
  renderTriggerTypesModule,
  TRIGGER_TYPES_SOURCE_PATH,
} from "./trigger-codegen.js";
import {
  buildTriggerKindRegistry,
  MCP_POLL_RUN_TOOL,
  type McpToolKindSpec,
  type TriggerKindInfo,
  type TriggerKindRuntime,
  type TriggerMode,
  triggerKindInfo,
} from "./trigger-kinds.js";
import {
  WorkflowEnablementSuspendedError,
  type WorkflowEnablementsService,
} from "./workflow-enablements-service.js";
import { WORKFLOW_READ_OPTIONS } from "./workflow-source-files.js";

const tracer = getTracer("@catamorphic/core");

/** A workflow's subscription to a kind, as hosts introspect it. */
export interface TriggerBindingInfo {
  workflowName: string;
  /** The host kind that fires the binding. */
  kind: string;
  /** That kind's config, without `where`. */
  config: Json;
  /**
   * Filters the payload must satisfy, all of them (ADR 0171): the
   * binding's own `where` and those of every project kind it resolves
   * through. Evaluated before a run starts.
   */
  where: Json[];
  /** The project trigger kind the workflow bound, for display. */
  projectKind?: string;
  /**
   * Whether any execution path can leave the run waiting on the clock or the
   * queue. `false` guarantees a sync firing returns a settled outcome.
   */
  canSuspend: boolean;
  inputParameters: ParameterInfo[];
  /** JSON Schema of the workflow input — tool-definition-ready. */
  inputSchema: Json;
  /** JSON Schema of the workflow's resolved output. */
  outputSchema: Json;
}

export interface StoredTriggerBinding extends TriggerBindingInfo {
  id: string;
  commitSha: string;
}

export interface StoredTriggerActivation extends StoredTriggerBinding {
  activationId: string;
  enablementId: string;
  environment: string;
}

export type TriggerSuspensionReason = RunSuspensionReason;

export type TriggerFireOutcome =
  | { workflowName: string; runId: string; status: "started" }
  | { workflowName: string; runId: string; status: "completed"; output: Json }
  | { workflowName: string; runId: string; status: "failed"; error: string }
  | {
      workflowName: string;
      runId: string;
      status: "suspended";
      suspendedOn: TriggerSuspensionReason;
    };

export interface TriggerFireResult {
  kind: string;
  mode: TriggerMode;
  commitSha: string | null;
  runs: TriggerFireOutcome[];
}

export class TriggerKindNotRegisteredError extends Error {
  constructor(kind: string, registered: string[]) {
    super(
      `Trigger kind '${kind}' is not registered with this host. Registered kinds: ${
        registered.length > 0 ? registered.join(", ") : "(none)"
      }`,
    );
    this.name = "TriggerKindNotRegisteredError";
  }
}

export class TriggerModeNotAllowedError extends Error {
  constructor(
    kind: string,
    mode: TriggerMode,
    allowed: readonly TriggerMode[],
  ) {
    super(
      `Trigger kind '${kind}' does not allow '${mode}' firing (allowed: ${allowed.join(", ")})`,
    );
    this.name = "TriggerModeNotAllowedError";
  }
}

export class TriggerPayloadInvalidError extends Error {
  constructor(
    kind: string,
    readonly errors: string[],
  ) {
    super(
      `Payload for trigger kind '${kind}' is invalid: ${errors.join("; ")}`,
    );
    this.name = "TriggerPayloadInvalidError";
  }
}

export class TriggerNotEnabledError extends Error {
  constructor(readonly kind: string) {
    super(`No active workflow enablement subscribes to trigger '${kind}'`);
    this.name = "TriggerNotEnabledError";
  }
}

/** The project's committed code declares bindings the host cannot honor. */
export class TriggerBindingsInvalidError extends Error {
  constructor(
    readonly projectId: string,
    readonly commitSha: string,
    readonly errors: string[],
  ) {
    super(
      `Trigger bindings at commit ${commitSha.slice(0, 12)} are invalid:\n${errors
        .map((error) => `  - ${error}`)
        .join("\n")}`,
    );
    this.name = "TriggerBindingsInvalidError";
  }
}

interface ScanResult {
  commitSha: string | null;
  bindings: TriggerBindingInfo[];
}

interface PinnedRevision {
  commitSha: string;
  remoteBranch: string;
}

interface FireArgs {
  identity: Identity;
  projectId: string;
  kind: string;
  payload: Json;
  environment?: string;
  mode?: TriggerMode;
  workflows?: readonly string[];
  enablementIds?: readonly string[];
  /** Narrows to exact activations: a durable delivery names the one it serves. */
  activationIds?: readonly string[];
  correlationKey?: string;
  onConflict?: EnrollmentConflictPolicy;
  budgetMs?: number;
  /** User-initiated tool calls use the caller's live authority. */
  interactive?: boolean;
}

interface TriggersServiceDeps {
  kinds: readonly TriggerKindRuntime[];
  /** Tool-kind declarations; scan validates effective tool-name uniqueness. */
  mcpToolKinds?: readonly McpToolKindSpec[];
  projectManager: ProjectManager;
  runs: RunsService;
  workflowEnablements?: () => WorkflowEnablementsService;
}

const DEFAULT_SYNC_BUDGET_MS = 30_000;
const MAX_SYNC_BUDGET_MS = 300_000;

/**
 * Host-defined trigger kinds: workflows subscribe with
 * `triggers: [trigger("kind", config)]`, hosts fire a kind with a payload and
 * every subscribed workflow runs. Bindings are extracted from the production
 * commit and frozen per (project, commit) in `trigger_definitions`, so firing —
 * a host request-path operation — reads a table, not a ts-morph parse.
 *
 * Sync firing drives the run's existing queue jobs inline (claim → run →
 * claim next) and detaches at the first wait — a pause, a retry backoff, a
 * rate limit, a batch, a child workflow, or budget exhaustion — by simply
 * leaving the next job pending for the polling workers.
 */
export class TriggersService {
  private readonly registry: Map<string, TriggerKindRuntime>;
  /** Scan memo keyed `projectId:commitSha`; sha-immutable, so hits are valid. */
  private readonly scans = new Map<string, Promise<TriggerBindingInfo[]>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: TriggersServiceDeps,
  ) {
    this.registry = buildTriggerKindRegistry(deps.kinds);
  }

  listKinds(): TriggerKindInfo[] {
    return [...this.registry.values()].map(triggerKindInfo);
  }

  kindInfo(name: string): TriggerKindInfo | null {
    const kind = this.registry.get(name);
    return kind ? triggerKindInfo(kind) : null;
  }

  /**
   * Renders the generated `work-triggers.d.ts` content: the host's kinds
   * and the project's own (ADR 0171), typed from their trigger modules.
   */
  typesModuleContent(
    input: { projectKinds?: readonly ProjectTriggerKind[] } = {},
  ): string {
    return renderTriggerTypesModule({
      kinds: [...this.registry.values()],
      projectKinds: (input.projectKinds ?? []).filter(
        (kind) => !this.registry.has(kind.name),
      ),
    });
  }

  /**
   * Writes every generated type projection into the project's dev tree and
   * commits when drifted: the trigger-kinds augmentation
   * (`.work/workflows/src/work-triggers.d.ts`) and, per app workspace, the
   * typed app-api client (`.work/apps/<name>/src/work-app-api.d.ts`).
   * Generated files are projections of code the host or project owns —
   * regenerated on change, never hand-edited.
   */
  async syncTypes(args: {
    identity: Identity;
    projectId: string;
  }): Promise<{ paths: string[]; updated: boolean }> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    assertProjectPermission(args.identity, args.projectId, "program:write");
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    try {
      const files = await repo.readAllFiles(WORKFLOW_READ_OPTIONS);
      // Generated types and the check script exist to serve the workflow
      // workspace. A project without one (docs-only, imported plain repo)
      // must not have a .work/workflows/ directory conjured into it (ADR 0043).
      if (files[PROJECT_WORKFLOWS_PACKAGE_PATH] === undefined) {
        return { paths: [], updated: false };
      }
      const changes = new Map<string, string>();
      const parsed = parseProject(files);
      const triggerContent = this.typesModuleContent({
        projectKinds: parsed.triggerKinds,
      });
      if (files[TRIGGER_TYPES_SOURCE_PATH] !== triggerContent) {
        changes.set(TRIGGER_TYPES_SOURCE_PATH, triggerContent);
      }
      if (parsed.appApi && parsed.errors.length === 0) {
        const content = renderAppApiTypesModule(parsed.appApi.entries);
        for (const appName of appWorkspaceNames(files)) {
          const path = appApiTypesPath(appName);
          if (files[path] !== content) changes.set(path, content);
        }
      }
      // Seed the project-owned check script once; it is the project's to
      // edit afterwards, so an existing file is never overwritten.
      if (files[PROJECT_CHECK_SCRIPT_PATH] === undefined) {
        changes.set(PROJECT_CHECK_SCRIPT_PATH, PROJECT_CHECK_SCRIPT);
      }
      if (changes.size === 0) return { paths: [], updated: false };
      for (const [path, content] of changes) {
        await repo.writeFile(path, content);
      }
      await repo.commit("Sync catamorphic generated types", SYSTEM_AUTHOR);
      return { paths: [...changes.keys()], updated: true };
    } finally {
      await repo.dispose();
    }
  }

  /**
   * Lists the workflows bound to a kind (or all kinds) at the project's
   * current production commit. An undeployed project has no bindings.
   */
  async list(args: {
    identity: Identity;
    projectId: string;
    kind?: string;
  }): Promise<TriggerBindingInfo[]> {
    if (args.kind && !this.registry.has(args.kind)) {
      throw new TriggerKindNotRegisteredError(args.kind, [
        ...this.registry.keys(),
      ]);
    }
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    const scan = await this.ensureScan(args);
    // Without `program:read`, only the workflows the caller may run.
    const reachable = hasProjectPermission(
      args.identity,
      args.projectId,
      "program:read",
    )
      ? null
      : ((
          await resolveScope({
            db: this.db,
            identity: args.identity,
            projectId: args.projectId,
          })
        )?.allowedWorkflows ?? null);
    return scan.bindings.filter(
      (binding) =>
        (!args.kind || binding.kind === args.kind) &&
        (!reachable || reachable.has(binding.workflowName)),
    );
  }

  /**
   * Lists frozen bindings from an explicit immutable revision. Temporary
   * workflow enablements use the same parser, registry, and authorization
   * projection as the production commit.
   */
  async listAtCommit(args: {
    identity: Identity;
    projectId: string;
    commitSha: string;
    remoteBranch: string;
    environment?: string;
    kind?: string;
    workflowName?: string;
  }): Promise<TriggerBindingInfo[]> {
    if (args.kind && !this.registry.has(args.kind)) {
      throw new TriggerKindNotRegisteredError(args.kind, [
        ...this.registry.keys(),
      ]);
    }
    const bindings = await this.ensureScanAtCommit(args);
    return bindings.filter(
      (binding) =>
        (!args.kind || binding.kind === args.kind) &&
        (!args.workflowName || binding.workflowName === args.workflowName),
    );
  }

  /** Production binding rows for host-owned durable trigger dispatchers. */
  async storedProductionBindings(args: {
    identity: Identity;
    projectId: string;
    kind: string;
  }): Promise<StoredTriggerBinding[]> {
    const scan = await this.ensureScan(args);
    if (!scan.commitSha) return [];
    const rows = await this.db
      .selectFrom("trigger_definitions")
      .selectAll()
      .where("project_id", "=", args.projectId)
      .where("commit_sha", "=", scan.commitSha)
      .where("trigger_kind", "=", args.kind)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      commitSha: row.commit_sha,
      ...bindingFromRow(row),
    }));
  }

  /** Active runtime instances of pinned trigger definitions, including temporary source. */
  async storedActiveActivations(args: {
    identity: Identity;
    projectId: string;
    kind: string;
  }): Promise<StoredTriggerActivation[]> {
    const rows = await this.db
      .selectFrom("workflow_enablement_triggers as activation")
      .innerJoin(
        "workflow_enablements as enablement",
        "enablement.id",
        "activation.enablement_id",
      )
      .innerJoin(
        "trigger_definitions as definition",
        "definition.id",
        "activation.trigger_definition_id",
      )
      .innerJoin("projects", "projects.id", "enablement.project_id")
      .select([
        "activation.id as activation_id",
        "activation.enablement_id",
        "definition.id",
        "definition.commit_sha",
        "definition.workflow_name",
        "definition.trigger_kind",
        "definition.config",
        "definition.where_filters",
        "definition.project_kind",
        "definition.can_suspend",
        "definition.input_parameters",
        "definition.input_schema",
        "definition.output_schema",
        "enablement.environment_name",
      ])
      .where("projects.tenant_id", "=", args.identity.tenantId)
      .where("definition.project_id", "=", args.projectId)
      .where("definition.trigger_kind", "=", args.kind)
      .where("activation.status", "=", "active")
      .where("enablement.status", "=", "active")
      .where(({ or, eb }) =>
        or([
          eb("enablement.expires_at", "is", null),
          eb("enablement.expires_at", ">", new Date()),
        ]),
      )
      .execute();
    return rows.map((row) => ({
      activationId: row.activation_id,
      enablementId: row.enablement_id,
      id: row.id,
      commitSha: row.commit_sha,
      environment: row.environment_name,
      ...bindingFromRow(row),
    }));
  }

  /**
   * The project's MCP tool roster at its production commit: effective tool
   * name → workflow name, for every binding of a registered tool kind. The
   * same naming the deploy scan validates and the MCP endpoint serves.
   */
  async mcpToolNames(args: {
    identity: Identity;
    projectId: string;
  }): Promise<ReadonlyMap<string, string>> {
    const specs = new Map(
      (this.deps.mcpToolKinds ?? []).map((spec) => [spec.kind, spec]),
    );
    const names = new Map<string, string>();
    if (specs.size === 0) return names;
    for (const binding of await this.list(args)) {
      const spec = specs.get(binding.kind);
      if (!spec) continue;
      const name = spec.tool(binding.config).name ?? binding.workflowName;
      if (!names.has(name)) names.set(name, binding.workflowName);
    }
    return names;
  }

  async fire(args: FireArgs): Promise<TriggerFireResult> {
    return this.fireFromScan(args, () => this.ensureScan(args));
  }

  /** Fire ordinary trigger bindings from an explicit immutable revision. */
  async fireAtCommit(
    args: FireArgs & PinnedRevision,
  ): Promise<TriggerFireResult> {
    return this.fireFromScan(
      args,
      async () => ({
        commitSha: args.commitSha,
        bindings: await this.ensureScanAtCommit(args),
      }),
      { commitSha: args.commitSha, remoteBranch: args.remoteBranch },
    );
  }

  private async fireFromScan(
    args: FireArgs,
    scan: () => Promise<ScanResult>,
    pinned?: PinnedRevision,
  ): Promise<TriggerFireResult> {
    const kind = this.registry.get(args.kind);
    if (!kind) {
      throw new TriggerKindNotRegisteredError(args.kind, [
        ...this.registry.keys(),
      ]);
    }
    const mode = args.mode ?? "async";
    const allowedModes = kind.modes ?? ["sync", "async"];
    if (!allowedModes.includes(mode)) {
      throw new TriggerModeNotAllowedError(kind.name, mode, allowedModes);
    }
    const payloadCheck = kind.validatePayload(args.payload);
    if (!payloadCheck.ok) {
      throw new TriggerPayloadInvalidError(kind.name, payloadCheck.errors);
    }
    const correlationKey =
      args.correlationKey ?? kind.correlationKey?.(args.payload);

    return withSpan(
      {
        tracer,
        name: "trigger.fire",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.project.id": args.projectId,
          "catamorphic.trigger.kind": kind.name,
          "catamorphic.trigger.mode": mode,
        },
      },
      async (span) => {
        const scanned = await scan();
        const productionDefinitions = scanned.bindings.filter(
          (binding) => binding.kind === kind.name,
        );
        let targets: Array<{
          binding: TriggerBindingInfo;
          enablementId?: string;
          activationId?: string;
        }>;
        if (args.interactive) {
          targets = productionDefinitions.map((binding) => ({ binding }));
        } else {
          const activations = await this.db
            .selectFrom("workflow_enablement_triggers as activation")
            .innerJoin(
              "workflow_enablements as enablement",
              "enablement.id",
              "activation.enablement_id",
            )
            .innerJoin(
              "trigger_definitions as definition",
              "definition.id",
              "activation.trigger_definition_id",
            )
            .select([
              "activation.id as activation_id",
              "activation.enablement_id",
              "definition.id",
              "definition.commit_sha",
              "definition.workflow_name",
              "definition.trigger_kind",
              "definition.config",
              "definition.where_filters",
              "definition.project_kind",
              "definition.can_suspend",
              "definition.input_parameters",
              "definition.input_schema",
              "definition.output_schema",
            ])
            .where("definition.project_id", "=", args.projectId)
            .where("definition.trigger_kind", "=", kind.name)
            .where("activation.status", "=", "active")
            .where("enablement.status", "=", "active")
            .execute();
          targets = activations.map((activation) => ({
            enablementId: activation.enablement_id,
            activationId: activation.activation_id,
            binding: bindingFromRow(activation),
          }));
          if (productionDefinitions.length > 0 && targets.length === 0) {
            throw new TriggerNotEnabledError(kind.name);
          }
        }
        if (args.enablementIds) {
          const enabled = new Set(args.enablementIds);
          targets = targets.filter(
            (target) => target.enablementId && enabled.has(target.enablementId),
          );
        }
        if (args.activationIds) {
          const activations = new Set(args.activationIds);
          targets = targets.filter(
            (target) =>
              target.activationId && activations.has(target.activationId),
          );
        }
        if (args.workflows) {
          const wanted = new Set(args.workflows);
          targets = targets.filter(({ binding }) =>
            wanted.has(binding.workflowName),
          );
        }
        if (kind.matches) {
          targets = targets.filter(({ binding }) =>
            kind.matches?.({
              config: binding.config as Json,
              payload: args.payload,
            }),
          );
        }
        // Declarative filters run here, on the control plane, for every
        // kind and every fire path (ADR 0171).
        targets = targets.filter(({ binding }) =>
          matchesAllWhere(binding.where, args.payload),
        );
        span.setAttribute("catamorphic.trigger.target_count", targets.length);

        const budgetMs = Math.min(
          Math.max(1_000, args.budgetMs ?? DEFAULT_SYNC_BUDGET_MS),
          MAX_SYNC_BUDGET_MS,
        );
        const deadline = Date.now() + budgetMs;

        const attempts = await Promise.allSettled(
          targets.map(({ binding, enablementId }) =>
            this.fireOne({
              identity: args.identity,
              projectId: args.projectId,
              workflowName: binding.workflowName,
              payload: args.payload,
              environment: args.environment,
              mode,
              correlationKey,
              onConflict: args.onConflict,
              deadline,
              commitSha: scanned.commitSha,
              triggerKind: binding.kind,
              enablementId,
              interactive: args.interactive ?? false,
              pinned,
            }),
          ),
        );
        const runs: TriggerFireOutcome[] = [];
        for (const attempt of attempts) {
          if (attempt.status === "fulfilled") {
            runs.push(attempt.value);
          } else if (
            !(attempt.reason instanceof WorkflowEnablementSuspendedError)
          ) {
            throw attempt.reason;
          }
        }
        return { kind: kind.name, mode, commitSha: scanned.commitSha, runs };
      },
    );
  }

  private async fireOne(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    payload: Json;
    environment?: string;
    mode: TriggerMode;
    correlationKey?: string;
    onConflict?: EnrollmentConflictPolicy;
    deadline: number;
    commitSha: string | null;
    triggerKind: string;
    enablementId?: string;
    interactive: boolean;
    pinned?: PinnedRevision;
  }): Promise<TriggerFireOutcome> {
    const runArgs = {
      identity: args.identity,
      projectId: args.projectId,
      workflowName: args.workflowName,
      input: args.payload,
      environment: args.environment,
      correlationKey: args.correlationKey,
      onConflict: args.onConflict,
    };
    const run = args.enablementId
      ? await this.deps.runs.triggerWithEnablement({
          ...runArgs,
          enablementId: args.enablementId,
        })
      : args.pinned
        ? await this.deps.runs.triggerAtCommit({
            ...runArgs,
            commitSha: args.pinned.commitSha,
            remoteBranch: args.pinned.remoteBranch,
          })
        : await this.deps.runs.triggerProduction(runArgs);
    if (args.mode === "async") {
      return {
        workflowName: args.workflowName,
        runId: run.id,
        status: "started",
      };
    }
    const outcome = await this.deps.runs.driveInline({
      tenantId: args.identity.tenantId,
      runId: run.id,
      deadline: args.deadline,
    });
    return { workflowName: args.workflowName, ...outcome };
  }

  /**
   * Resolves the production commit and returns its frozen bindings, scanning
   * (parse → validate → persist) the first time a commit is seen.
   */
  private async ensureScan(args: {
    identity: Identity;
    projectId: string;
  }): Promise<ScanResult> {
    const remote = this.deps.projectManager.remoteBackend;
    if (!remote) return { commitSha: null, bindings: [] };
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    let commitSha: string | null = null;
    let files: Record<string, string> | undefined;
    try {
      await fetchRemote({
        dev: repo,
        remote,
        tenantId: args.identity.tenantId,
        projectId: args.projectId,
        remoteBranch: "main",
      });
      commitSha = await repo.resolveRef(publishedRef()).catch(() => null);
      if (!commitSha) return { commitSha: null, bindings: [] };
      await this.deps.workflowEnablements?.().markUpdateAvailable({
        projectId: args.projectId,
        commitSha,
      });

      const memoKey = `${args.projectId}:${commitSha}`;
      const memoized = this.scans.get(memoKey);
      if (memoized) {
        return { commitSha, bindings: await memoized };
      }
      const recorded = await this.readRecordedScan({
        projectId: args.projectId,
        commitSha,
      });
      if (recorded) {
        this.scans.set(memoKey, Promise.resolve(recorded));
        this.capScanMemo();
        return { commitSha, bindings: recorded };
      }
      files = await repo.readAllFilesAtRef(commitSha, WORKFLOW_READ_OPTIONS);
    } finally {
      await repo.dispose();
    }

    const memoKey = `${args.projectId}:${commitSha}`;
    const scanning = this.scanAndRecord({
      identity: args.identity,
      projectId: args.projectId,
      commitSha,
      files,
    });
    this.scans.set(memoKey, scanning);
    this.capScanMemo();
    try {
      return { commitSha, bindings: await scanning };
    } catch (error) {
      this.scans.delete(memoKey);
      throw error;
    }
  }

  private async ensureScanAtCommit(args: {
    identity: Identity;
    projectId: string;
    commitSha: string;
    remoteBranch: string;
    environment?: string;
  }): Promise<TriggerBindingInfo[]> {
    const memoKey = `${args.projectId}:${args.commitSha}`;
    const memoized = this.scans.get(memoKey);
    if (memoized) return memoized;
    const recorded = await this.readRecordedScan(args);
    if (recorded) {
      this.scans.set(memoKey, Promise.resolve(recorded));
      this.capScanMemo();
      return recorded;
    }

    const remote = this.deps.projectManager.remoteBackend;
    if (!remote) {
      throw new Error("Trigger revisions require durable project storage");
    }
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      `trigger-scan-${args.commitSha}`,
    );
    let files: Record<string, string>;
    try {
      await fetchRemote({
        dev: repo,
        remote,
        tenantId: args.identity.tenantId,
        projectId: args.projectId,
        remoteBranch: args.remoteBranch,
      });
      const fetchedCommit = await repo
        .resolveRef(publishedRef(args.remoteBranch))
        .catch(() => null);
      if (fetchedCommit !== args.commitSha) {
        throw new Error(
          `Trigger revision ${args.commitSha} is not available at '${args.remoteBranch}'`,
        );
      }
      files = await repo.readAllFilesAtRef(
        args.commitSha,
        WORKFLOW_READ_OPTIONS,
      );
    } finally {
      await repo.dispose();
    }

    const scanning = this.scanAndRecord({
      identity: args.identity,
      projectId: args.projectId,
      commitSha: args.commitSha,
      files,
      environment: args.environment,
    });
    this.scans.set(memoKey, scanning);
    this.capScanMemo();
    try {
      return await scanning;
    } catch (error) {
      this.scans.delete(memoKey);
      throw error;
    }
  }

  private capScanMemo(): void {
    // Each deploy strands its predecessor's entry; keep the map bounded.
    while (this.scans.size > 256) {
      const oldest = this.scans.keys().next().value;
      if (oldest === undefined) return;
      this.scans.delete(oldest);
    }
  }

  private async readRecordedScan(args: {
    projectId: string;
    commitSha: string;
  }): Promise<TriggerBindingInfo[] | null> {
    const scan = await this.db
      .selectFrom("trigger_definition_scans")
      .select("scanned_at")
      .where("project_id", "=", args.projectId)
      .where("commit_sha", "=", args.commitSha)
      .executeTakeFirst();
    if (!scan) return null;
    const rows = await this.db
      .selectFrom("trigger_definitions")
      .selectAll()
      .where("project_id", "=", args.projectId)
      .where("commit_sha", "=", args.commitSha)
      .orderBy("workflow_name", "asc")
      .orderBy("binding_index", "asc")
      .execute();
    return rows.map(bindingFromRow);
  }

  private async scanAndRecord(args: {
    identity: Identity;
    projectId: string;
    commitSha: string;
    files: Record<string, string>;
    environment?: string;
  }): Promise<TriggerBindingInfo[]> {
    const parsed = parseProject(args.files);
    const errors: string[] = [];
    // Fail closed, like app contract resolution: shipping a commit whose
    // workflows cannot be parsed means the binding set is unknowable.
    for (const error of parsed.errors) {
      errors.push(
        error.file ? `${error.file}: ${error.message}` : error.message,
      );
    }
    errors.push(...this.projectKindErrors(parsed.triggerKinds));
    const bindings: Array<
      TriggerBindingInfo & {
        connectionRequirements: Json;
        bindingIndex: number;
      }
    > = [];
    for (const workflow of parsed.workflows) {
      for (const [bindingIndex, written] of workflow.graph.triggers.entries()) {
        // Project kinds (ADR 0171) resolve to the host kind they build on,
        // carrying every filter along the chain.
        const resolved = resolveTriggerBinding({
          binding: written,
          projectKinds: parsed.triggerKinds,
        });
        if (!resolved.ok) {
          errors.push(
            `Workflow '${workflow.functionName}' trigger '${written.kind}': ${resolved.error}`,
          );
          continue;
        }
        const binding = resolved.binding;
        const kind = this.registry.get(binding.kind);
        if (!kind) {
          errors.push(
            `Workflow '${workflow.functionName}' binds unknown trigger kind '${written.kind}' (registered: ${[...this.registry.keys()].join(", ") || "none"}; project: ${parsed.triggerKinds.map((projectKind) => projectKind.name).join(", ") || "none"})`,
          );
          continue;
        }
        const configCheck = kind.validateConfig(binding.config as Json);
        if (!configCheck.ok) {
          errors.push(
            `Workflow '${workflow.functionName}' trigger '${written.kind}' config: ${configCheck.errors.join("; ")}`,
          );
          continue;
        }
        // Holes in the kind's template freeze to this workflow's derived
        // input schema (ADR 0042). A hole that would freeze to nothing —
        // undeclared or permissive — fails the commit closed: shipping a
        // tool/endpoint with an unknowable argument shape is an authoring
        // error better caught at deploy than at call time.
        const holeErrors = holeSchemaErrors({
          payloadSchema: kind.payloadJsonSchema,
          inputSchema: workflow.graph.inputSchema ?? {},
        });
        if (holeErrors.length > 0) {
          errors.push(
            ...holeErrors.map(
              (error) =>
                `Workflow '${workflow.functionName}' trigger '${binding.kind}': ${error}`,
            ),
          );
          continue;
        }
        bindings.push({
          workflowName: workflow.functionName,
          kind: binding.kind,
          config: binding.config as Json,
          where: binding.where as Json[],
          ...(binding.projectKind ? { projectKind: binding.projectKind } : {}),
          canSuspend: workflow.graph.canSuspend,
          inputParameters: workflow.graph.input.parameters,
          inputSchema: (workflow.graph.inputSchema ?? {}) as Json,
          outputSchema: (workflow.graph.outputSchema ?? {}) as Json,
          connectionRequirements: JSON.parse(
            JSON.stringify(workflow.graph.connections),
          ) as Json,
          bindingIndex,
        });
      }
    }
    // One webhook name is one URL that verifies and answers senders one
    // way: every binding of a name, however it got there (directly or
    // through project kinds), must declare the same settings.
    const webhookSettings = new Map<
      string,
      { workflow: string; settings: string }
    >();
    for (const binding of bindings) {
      if (binding.kind !== "webhook") continue;
      const parsedConfig = webhookConfig.safeParse(binding.config);
      if (!parsedConfig.success) continue;
      const name = parsedConfig.data.name;
      const settings = webhookSettingsKey(parsedConfig.data);
      const first = webhookSettings.get(name);
      if (!first) {
        webhookSettings.set(name, { workflow: binding.workflowName, settings });
      } else if (first.settings !== settings) {
        errors.push(
          `Workflows '${first.workflow}' and '${binding.workflowName}' bind webhook '${name}' with different settings (verify, respond, deliveryId, maxBodyBytes); declare the webhook once in a project trigger kind`,
        );
      }
    }
    // Effective MCP tool names must be unique per project and may not claim
    // the shared poll tool. Serve time keeps a backstop, but the primary
    // enforcement is here: a name collision should stop the deploy, not
    // brick the project's tool roster for an agent mid-session.
    const toolSpecs = new Map(
      (this.deps.mcpToolKinds ?? []).map((spec) => [spec.kind, spec]),
    );
    const toolNames = new Map<string, string>();
    for (const binding of bindings) {
      const spec = toolSpecs.get(binding.kind);
      if (!spec) continue;
      const name = spec.tool(binding.config).name ?? binding.workflowName;
      if (name === MCP_POLL_RUN_TOOL) {
        errors.push(
          `Workflow '${binding.workflowName}' trigger '${binding.kind}': tool name '${name}' is reserved`,
        );
        continue;
      }
      const owner = toolNames.get(name);
      if (owner) {
        errors.push(
          `Workflows '${owner}' and '${binding.workflowName}' both resolve to MCP tool name '${name}'; rename one via its trigger config`,
        );
        continue;
      }
      toolNames.set(name, binding.workflowName);
    }
    if (errors.length > 0) {
      throw new TriggerBindingsInvalidError(
        args.projectId,
        args.commitSha,
        errors,
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("trigger_definition_scans")
        .values({ project_id: args.projectId, commit_sha: args.commitSha })
        .onConflict((oc) =>
          oc.columns(["project_id", "commit_sha"]).doNothing(),
        )
        .execute();
      if (bindings.length > 0) {
        await trx
          .insertInto("trigger_definitions")
          .values(
            bindings.map((binding) => ({
              project_id: args.projectId,
              commit_sha: args.commitSha,
              trigger_kind: binding.kind,
              workflow_name: binding.workflowName,
              // Stringified so array-valued JSON is not mistaken for a
              // Postgres array literal by the driver.
              config: JSON.stringify(binding.config),
              where_filters: JSON.stringify(binding.where),
              project_kind: binding.projectKind ?? null,
              binding_index: binding.bindingIndex,
              can_suspend: binding.canSuspend,
              input_parameters: JSON.stringify(binding.inputParameters),
              input_schema: JSON.stringify(binding.inputSchema),
              output_schema: JSON.stringify(binding.outputSchema),
              connection_requirements: JSON.stringify(
                binding.connectionRequirements,
              ),
            })),
          )
          .onConflict((oc) =>
            oc
              .columns([
                "project_id",
                "commit_sha",
                "workflow_name",
                "binding_index",
              ])
              .doNothing(),
          )
          .execute();
      }
    });
    return bindings.map(
      ({ connectionRequirements: _, bindingIndex: __, ...binding }) => binding,
    );
  }

  /**
   * Project kinds that could never fire on this host (ADR 0171): a name a
   * host kind already has, or a chain whose root kind is not registered or
   * rejects the config. Checked whether or not a workflow binds them.
   */
  private projectKindErrors(kinds: readonly ProjectTriggerKind[]): string[] {
    const errors: string[] = [];
    for (const kind of kinds) {
      if (this.registry.has(kind.name)) {
        errors.push(
          `Trigger kind '${kind.name}' (${kind.filePath}) is already a host kind; give the project's kind another name`,
        );
        continue;
      }
      const resolved = resolveTriggerBinding({
        binding: { kind: kind.name, config: {} },
        projectKinds: kinds,
      });
      if (!resolved.ok) continue; // a cycle, reported by the parse
      const root = this.registry.get(resolved.binding.kind);
      if (!root) {
        errors.push(
          `Trigger kind '${kind.name}' builds on unknown trigger kind '${resolved.binding.kind}'`,
        );
        continue;
      }
      const check = root.validateConfig(resolved.binding.config as Json);
      if (!check.ok)
        errors.push(
          `Trigger kind '${kind.name}' from '${root.name}' config: ${check.errors.join("; ")}`,
        );
    }
    return errors;
  }
}

/** A stored definition as hosts introspect it. */
function bindingFromRow(row: {
  workflow_name: string;
  trigger_kind: string;
  config: Json;
  where_filters: Json;
  project_kind: string | null;
  can_suspend: boolean;
  input_parameters: Json;
  input_schema: Json;
  output_schema: Json;
}): TriggerBindingInfo {
  return {
    workflowName: row.workflow_name,
    kind: row.trigger_kind,
    config: row.config ?? {},
    where: Array.isArray(row.where_filters) ? row.where_filters : [],
    ...(row.project_kind ? { projectKind: row.project_kind } : {}),
    canSuspend: row.can_suspend,
    inputParameters: (row.input_parameters ?? []) as unknown as ParameterInfo[],
    inputSchema: row.input_schema ?? {},
    outputSchema: row.output_schema ?? {},
  };
}
