import type { DB, Json } from "@catamorphic/db";
import { fetchRemote, type ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  appApiTypesPath,
  appWorkspaceNames,
  holeSchemaErrors,
  type ParameterInfo,
  parseProject,
  renderAppApiTypesModule,
} from "@catamorphic/parser";
import type { Kysely } from "kysely";
import { z } from "zod";
import { type Identity, SYSTEM_AUTHOR } from "../identity.js";
import { PROJECT_CHECK_SCRIPT, PROJECT_CHECK_SCRIPT_PATH } from "../seeds.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import type { ExecutionEnvironmentsService } from "./execution-environments-service.js";
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

const tracer = getTracer("@catamorphic/core");

/** A workflow's subscription to a kind, as hosts introspect it. */
export interface TriggerBindingInfo {
  workflowName: string;
  kind: string;
  config: Json;
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

interface TriggersServiceDeps {
  kinds: readonly TriggerKindRuntime[];
  /** Tool-kind declarations; scan validates effective tool-name uniqueness. */
  mcpToolKinds?: readonly McpToolKindSpec[];
  projectManager: ProjectManager;
  runs: RunsService;
  executionEnvironments: ExecutionEnvironmentsService;
  connectionAdmission?: ConnectionAdmissionService;
}

const TriggerAuthorizationSnapshotSchema = z.array(
  z.object({
    bindingId: z.string().uuid(),
    connectionId: z.string().uuid(),
    alias: z.string(),
    providerKind: z.string(),
    principalKind: z.enum(["project_service", "tenant_service"]),
    capabilities: z.array(z.string()),
  }),
);

interface TriggerAuthorization {
  environment: string;
  connections: readonly ResolvedConnectionBinding[];
}

const DEFAULT_SYNC_BUDGET_MS = 30_000;
const MAX_SYNC_BUDGET_MS = 300_000;

/**
 * Host-defined trigger kinds: workflows subscribe with
 * `triggers: [trigger("kind", config)]`, hosts fire a kind with a payload and
 * every subscribed workflow runs. Bindings are extracted from the production
 * commit and frozen per (project, commit) in `trigger_bindings`, so firing —
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

  /** Renders the generated `catamorphic-triggers.d.ts` content. */
  typesModuleContent(): string {
    return renderTriggerTypesModule([...this.registry.values()]);
  }

  /**
   * Writes every generated type projection into the project's dev tree and
   * commits when drifted: the trigger-kinds augmentation
   * (`workflows/src/catamorphic-triggers.d.ts`) and, per app workspace, the
   * typed app-api client (`apps/<name>/src/catamorphic-app-api.d.ts`).
   * Generated files are projections of code the host or project owns —
   * regenerated on change, never hand-edited.
   */
  async syncTypes(args: {
    identity: Identity;
    projectId: string;
  }): Promise<{ paths: string[]; updated: boolean }> {
    const repo = await this.deps.projectManager.openDev(
      args.identity.tenantId,
      args.projectId,
      args.identity.externalUserId,
    );
    try {
      const files = await repo.readAllFiles();
      // Generated types and the check script exist to serve the workflow
      // workspace. A project without one (docs-only, imported plain repo)
      // must not have a workflows/ directory conjured into it (ADR 0043).
      if (files["workflows/package.json"] === undefined) {
        return { paths: [], updated: false };
      }
      const changes = new Map<string, string>();
      const triggerContent = this.typesModuleContent();
      if (files[TRIGGER_TYPES_SOURCE_PATH] !== triggerContent) {
        changes.set(TRIGGER_TYPES_SOURCE_PATH, triggerContent);
      }
      const parsed = parseProject(files);
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
    const scan = await this.ensureScan(args);
    return args.kind
      ? scan.bindings.filter((binding) => binding.kind === args.kind)
      : scan.bindings;
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

  async fire(args: {
    identity: Identity;
    projectId: string;
    kind: string;
    payload: Json;
    environment?: string;
    /** Defaults to async. */
    mode?: TriggerMode;
    /** Restrict to these bound workflows (e.g. the one tool the AI called). */
    workflows?: readonly string[];
    correlationKey?: string;
    onConflict?: EnrollmentConflictPolicy;
    /** Sync only: wall-clock budget before detaching. Defaults to 30s. */
    budgetMs?: number;
  }): Promise<TriggerFireResult> {
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
          "catamorphic.project.id": args.projectId,
          "catamorphic.trigger.kind": kind.name,
          "catamorphic.trigger.mode": mode,
        },
      },
      async (span) => {
        const scan = await this.ensureScan(args);
        let targets = scan.bindings.filter(
          (binding) => binding.kind === kind.name,
        );
        if (args.workflows) {
          const wanted = new Set(args.workflows);
          targets = targets.filter((binding) =>
            wanted.has(binding.workflowName),
          );
        }
        span.setAttribute("catamorphic.trigger.target_count", targets.length);

        const budgetMs = Math.min(
          Math.max(1_000, args.budgetMs ?? DEFAULT_SYNC_BUDGET_MS),
          MAX_SYNC_BUDGET_MS,
        );
        const deadline = Date.now() + budgetMs;

        const runs = await Promise.all(
          targets.map((binding) =>
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
              commitSha: scan.commitSha,
              triggerKind: binding.kind,
            }),
          ),
        );
        return { kind: kind.name, mode, commitSha: scan.commitSha, runs };
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
  }): Promise<TriggerFireOutcome> {
    const authorization = args.commitSha
      ? await this.readAuthorization({
          projectId: args.projectId,
          commitSha: args.commitSha,
          triggerKind: args.triggerKind,
          workflowName: args.workflowName,
        })
      : undefined;
    if (
      args.environment &&
      authorization &&
      args.environment !== authorization.environment
    ) {
      throw new Error(
        `Trigger '${args.triggerKind}' for workflow '${args.workflowName}' is configured for Environment '${authorization.environment}'`,
      );
    }
    const run = await this.deps.runs.triggerUnattendedProduction({
      identity: args.identity,
      projectId: args.projectId,
      workflowName: args.workflowName,
      input: args.payload,
      environment: authorization?.environment ?? args.environment,
      connectionAuthorizationSnapshot: authorization?.connections,
      correlationKey: args.correlationKey,
      onConflict: args.onConflict,
    });
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
      commitSha = await repo
        .resolveRef("refs/remotes/origin/main")
        .catch(() => null);
      if (!commitSha) return { commitSha: null, bindings: [] };

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
      files = await repo.readAllFilesAtRef(commitSha);
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
      .selectFrom("trigger_binding_scans")
      .select("scanned_at")
      .where("project_id", "=", args.projectId)
      .where("commit_sha", "=", args.commitSha)
      .executeTakeFirst();
    if (!scan) return null;
    const rows = await this.db
      .selectFrom("trigger_bindings")
      .selectAll()
      .where("project_id", "=", args.projectId)
      .where("commit_sha", "=", args.commitSha)
      .orderBy("workflow_name", "asc")
      .execute();
    return rows.map((row) => ({
      workflowName: row.workflow_name,
      kind: row.trigger_kind,
      config: (row.config ?? {}) as Json,
      canSuspend: row.can_suspend,
      inputParameters: (row.input_parameters ??
        []) as unknown as ParameterInfo[],
      inputSchema: (row.input_schema ?? {}) as Json,
      outputSchema: (row.output_schema ?? {}) as Json,
    }));
  }

  private async scanAndRecord(args: {
    identity: Identity;
    projectId: string;
    commitSha: string;
    files: Record<string, string>;
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
    const bindings: Array<
      TriggerBindingInfo & {
        environment?: string;
        connectionRequirements: Json;
        connectionAuthorizationSnapshot?: readonly ResolvedConnectionBinding[];
      }
    > = [];
    const authorizations = new Map<string, TriggerAuthorization>();
    for (const workflow of parsed.workflows) {
      let authorization = authorizations.get(workflow.functionName);
      if (workflow.graph.triggers.length > 0 && !authorization) {
        const environment = await this.deps.executionEnvironments.admit({
          identity: args.identity,
          projectId: args.projectId,
          requirements: { workload: "workflow" },
        });
        const requirements = workflow.graph.connections ?? [];
        if (requirements.length > 0 && !this.deps.connectionAdmission) {
          throw new Error("Connection providers are not configured");
        }
        const connections =
          requirements.length > 0
            ? await this.deps.connectionAdmission!.admit({
                identity: args.identity,
                projectId: args.projectId,
                environment: environment.environmentName,
                requirements,
                unattended: true,
              })
            : [];
        authorization = {
          environment: environment.environmentName,
          connections,
        };
        authorizations.set(workflow.functionName, authorization);
      }
      for (const binding of workflow.graph.triggers) {
        const kind = this.registry.get(binding.kind);
        if (!kind) {
          errors.push(
            `Workflow '${workflow.functionName}' binds unknown trigger kind '${binding.kind}' (registered: ${[...this.registry.keys()].join(", ") || "none"})`,
          );
          continue;
        }
        const configCheck = kind.validateConfig(binding.config as Json);
        if (!configCheck.ok) {
          errors.push(
            `Workflow '${workflow.functionName}' trigger '${binding.kind}' config: ${configCheck.errors.join("; ")}`,
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
          canSuspend: workflow.graph.canSuspend,
          inputParameters: workflow.graph.input.parameters,
          inputSchema: (workflow.graph.inputSchema ?? {}) as Json,
          outputSchema: (workflow.graph.outputSchema ?? {}) as Json,
          connectionRequirements: JSON.parse(
            JSON.stringify(workflow.graph.connections),
          ) as Json,
          ...(authorization
            ? {
                environment: authorization.environment,
                connectionAuthorizationSnapshot: authorization.connections,
              }
            : {}),
        });
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
        .insertInto("trigger_binding_scans")
        .values({ project_id: args.projectId, commit_sha: args.commitSha })
        .onConflict((oc) =>
          oc.columns(["project_id", "commit_sha"]).doNothing(),
        )
        .execute();
      if (bindings.length > 0) {
        await trx
          .insertInto("trigger_bindings")
          .values(
            bindings.map((binding) => ({
              project_id: args.projectId,
              commit_sha: args.commitSha,
              trigger_kind: binding.kind,
              workflow_name: binding.workflowName,
              // Stringified so array-valued JSON is not mistaken for a
              // Postgres array literal by the driver.
              config: JSON.stringify(binding.config),
              can_suspend: binding.canSuspend,
              input_parameters: JSON.stringify(binding.inputParameters),
              input_schema: JSON.stringify(binding.inputSchema),
              output_schema: JSON.stringify(binding.outputSchema),
              environment_name: binding.environment ?? null,
              connection_requirements: JSON.stringify(
                binding.connectionRequirements,
              ),
              connection_authorization_snapshot:
                binding.connectionAuthorizationSnapshot === undefined
                  ? null
                  : JSON.stringify(binding.connectionAuthorizationSnapshot),
            })),
          )
          .onConflict((oc) =>
            oc
              .columns([
                "project_id",
                "commit_sha",
                "trigger_kind",
                "workflow_name",
              ])
              .doNothing(),
          )
          .execute();
      }
    });
    return bindings;
  }

  private async readAuthorization(args: {
    projectId: string;
    commitSha: string;
    triggerKind: string;
    workflowName: string;
  }): Promise<TriggerAuthorization | undefined> {
    const row = await this.db
      .selectFrom("trigger_bindings")
      .where("project_id", "=", args.projectId)
      .where("commit_sha", "=", args.commitSha)
      .where("trigger_kind", "=", args.triggerKind)
      .where("workflow_name", "=", args.workflowName)
      .select(["environment_name", "connection_authorization_snapshot"])
      .executeTakeFirst();
    if (!row?.environment_name) return undefined;
    return {
      environment: row.environment_name,
      connections: TriggerAuthorizationSnapshotSchema.parse(
        row.connection_authorization_snapshot ?? [],
      ),
    };
  }
}
