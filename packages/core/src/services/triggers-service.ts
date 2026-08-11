import type { DB, Json } from "@catamorphic/db";
import { fetchRemote, type ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type ParameterInfo, parseProject } from "@catamorphic/parser";
import type { Kysely } from "kysely";
import { type Identity, SYSTEM_AUTHOR } from "../identity.js";
import { appApiTypesPath, renderAppApiTypesModule } from "./app-codegen.js";
import type { ExecutionJobsService } from "./execution-jobs-service.js";
import type { ExecutionWorkerService } from "./execution-worker-service.js";
import type { EnrollmentConflictPolicy, RunsService } from "./runs-service.js";
import {
  renderTriggerTypesModule,
  TRIGGER_TYPES_SOURCE_PATH,
} from "./trigger-codegen.js";
import {
  buildTriggerKindRegistry,
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

export type TriggerSuspensionReason =
  | "pause"
  | "child"
  | "paused"
  | "backoff"
  | "batch"
  | "budget"
  | "queue";

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
  projectManager: ProjectManager;
  runs: RunsService;
  executionJobs: ExecutionJobsService;
  executionWorker: ExecutionWorkerService;
}

const DEFAULT_SYNC_BUDGET_MS = 30_000;
const MAX_SYNC_BUDGET_MS = 300_000;
const SYNC_LEASE_SECONDS = 60;
/** Poll cadence while another worker holds the run's current job. */
const SYNC_POLL_MS = 50;

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

  async fire(args: {
    identity: Identity;
    projectId: string;
    kind: string;
    payload: Json;
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
              mode,
              correlationKey,
              onConflict: args.onConflict,
              deadline,
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
    mode: TriggerMode;
    correlationKey?: string;
    onConflict?: EnrollmentConflictPolicy;
    deadline: number;
  }): Promise<TriggerFireOutcome> {
    const run = await this.deps.runs.triggerProduction({
      identity: args.identity,
      projectId: args.projectId,
      workflowName: args.workflowName,
      input: args.payload,
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
    return this.driveRunInline({
      tenantId: args.identity.tenantId,
      workflowName: args.workflowName,
      runId: run.id,
      deadline: args.deadline,
    });
  }

  /**
   * Runs a run's queue jobs inline until it settles or would wait. Detaching
   * is always just "stop claiming": the next job stays pending and the
   * polling workers continue the run asynchronously.
   */
  private async driveRunInline(args: {
    tenantId: string;
    workflowName: string;
    runId: string;
    deadline: number;
  }): Promise<TriggerFireOutcome> {
    const workerId = `sync-trigger:${crypto.randomUUID()}`;
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(),
      Math.max(0, args.deadline - Date.now()),
    );
    try {
      for (;;) {
        const run = await this.db
          .selectFrom("workflow_runs")
          .select(["status", "phase", "result", "error"])
          .where("id", "=", args.runId)
          .executeTakeFirst();
        if (!run) {
          return {
            workflowName: args.workflowName,
            runId: args.runId,
            status: "failed",
            error: "Run disappeared while executing",
          };
        }
        if (run.status === "completed") {
          return {
            workflowName: args.workflowName,
            runId: args.runId,
            status: "completed",
            output: (run.result ?? null) as Json,
          };
        }
        if (run.status === "failed" || run.status === "canceled") {
          return {
            workflowName: args.workflowName,
            runId: args.runId,
            status: "failed",
            error: run.error ?? `Run ${run.status}`,
          };
        }
        if (run.status === "waiting") {
          return this.suspended(
            args,
            run.phase === "pause" ? "pause" : "child",
          );
        }
        if (run.status === "paused" || run.status === "canceling") {
          return this.suspended(args, "paused");
        }
        if (Date.now() >= args.deadline) {
          return this.suspended(args, "budget");
        }

        const job = await this.deps.executionJobs.nextForRun({
          tenantId: args.tenantId,
          runId: args.runId,
        });
        if (!job) {
          // The run is live but jobless: a transition is committing on
          // another connection. Bounded by the deadline check above.
          await delay(SYNC_POLL_MS);
          continue;
        }
        if (job.status === "running") {
          // A polling worker beat us to the claim; wait for its outcome.
          await delay(SYNC_POLL_MS);
          continue;
        }
        if (job.kind !== "durable_boundary") {
          return this.suspended(args, "batch");
        }
        if (new Date(job.availableAt).getTime() > Date.now()) {
          return this.suspended(args, "backoff");
        }
        const claimed = await this.deps.executionJobs.claimById({
          jobId: job.id,
          workerId,
          leaseSeconds: SYNC_LEASE_SECONDS,
        });
        if (!claimed) continue;
        await this.deps.executionWorker.runClaimedJob({
          job: claimed,
          workerId,
          leaseSeconds: SYNC_LEASE_SECONDS,
          signal: controller.signal,
        });
        // Every disposition — completed, deferred, failed, lease lost — is
        // reflected in the run/job rows the next iteration reads.
      }
    } finally {
      clearTimeout(abortTimer);
    }
  }

  private suspended(
    args: { workflowName: string; runId: string },
    suspendedOn: TriggerSuspensionReason,
  ): TriggerFireOutcome {
    return {
      workflowName: args.workflowName,
      runId: args.runId,
      status: "suspended",
      suspendedOn,
    };
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
    const bindings: TriggerBindingInfo[] = [];
    for (const workflow of parsed.workflows) {
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
        bindings.push({
          workflowName: workflow.functionName,
          kind: binding.kind,
          config: binding.config as Json,
          canSuspend: workflow.graph.canSuspend,
          inputParameters: workflow.graph.input.parameters,
          inputSchema: (workflow.graph.inputSchema ?? {}) as Json,
          outputSchema: (workflow.graph.outputSchema ?? {}) as Json,
        });
      }
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
}

function appWorkspaceNames(files: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const filePath of Object.keys(files)) {
    const match = /^apps\/([^/]+)\/package\.json$/.exec(filePath);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
