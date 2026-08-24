/**
 * Workspace roots inside a user project. A project is a bun workspace holding
 * backend workflows and frontend apps in one repo; `contracts` carries only
 * types and is the sole package both sides may depend on.
 */
export const WORKFLOW_SOURCE_ROOT = "workflows";
export const CONTRACTS_SOURCE_ROOT = "contracts";
export const APP_SOURCE_ROOT = "apps";

/** Guest runtime package; frontend-only, never resolvable in execution installs. */
export const APP_RUNTIME_PACKAGE = "@catamorphic/app";

/**
 * The project's dev-time tooling package (the seeded `scripts/check.ts`
 * imports it). Dev-only: stripped from every sandbox install alongside the
 * app runtime, so `bun install` inside execution and build sandboxes never
 * tries to resolve it.
 */
export const PROJECT_TOOLING_PACKAGE = "@catamorphic/parser";

/** Packages stripped from manifests before any sandbox `bun install`. */
export const SANDBOX_STRIPPED_PACKAGES: readonly string[] = [
  APP_RUNTIME_PACKAGE,
  PROJECT_TOOLING_PACKAGE,
];

/**
 * Drops frontend app sources from a project file set, and strips the
 * frontend-only `@catamorphic/app` dependency from remaining manifests
 * (contracts declares it for types). Apps never execute in a workflow
 * sandbox, so excluding them keeps app edits from invalidating the execution
 * artifact digest and keeps frontend dependencies out of the execution
 * sandbox — including from its `bun install`, where an unresolvable
 * registry-less package would fail the run.
 */
export function executionFiles(
  files: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .filter(
        ([filePath]) =>
          !filePath.replace(/^\/+/, "").startsWith(`${APP_SOURCE_ROOT}/`),
      )
      .map(([filePath, content]) => [
        filePath,
        filePath.endsWith("package.json")
          ? stripSandboxUnresolvableDependencies(content)
          : content,
      ]),
  );
}

function stripSandboxUnresolvableDependencies(packageJson: string): string {
  if (!SANDBOX_STRIPPED_PACKAGES.some((name) => packageJson.includes(name))) {
    return packageJson;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return packageJson;
  }
  if (typeof parsed !== "object" || parsed === null) return packageJson;
  const manifest = parsed as Record<string, unknown>;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const deps = manifest[section];
    if (typeof deps === "object" && deps !== null) {
      for (const name of SANDBOX_STRIPPED_PACKAGES) {
        delete (deps as Record<string, unknown>)[name];
      }
    }
  }
  return JSON.stringify(manifest, null, 2);
}

export type WorkflowNodeType =
  | "input"
  | "source"
  | "sink"
  | "step"
  | "branch"
  | "if-block"
  | "loop-block"
  | "parallel"
  | "parallel-block"
  | "scope-block"
  | "durable-boundary"
  | "batch"
  | "pause"
  | "call-workflow"
  | "delay"
  | "return";

export interface SourceRange {
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  file?: string;
}

export interface ParameterInfo {
  name: string;
  type: string;
  optional: boolean;
  displayName?: string;
  description?: string;
  defaultValue?: string;
  /** JSON Schema of this parameter's type, when statically derivable. */
  schema?: unknown;
}

export interface StepArgumentSource {
  variable: string;
  variableDisplayName?: string;
  stepNodeId?: string;
  stepLabel?: string;
}

export interface StepArgument {
  name: string;
  displayName?: string;
  value: string;
  source?: StepArgumentSource;
}

/**
 * How a host wants a trigger kind rendered. Filled in by the serving layer
 * from the host's registered kinds — the parser only knows kind names.
 */
export interface TriggerKindDisplay {
  label?: string;
  icon?: string;
  color?: string;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  description?: string;
  sourceRange: SourceRange;
  metadata: Record<string, string>;
  /** Present on the entry `input` node when the workflow declares triggers. */
  triggerBindings?: Array<{
    kind: string;
    /** Always a JsonConstant; see {@link WorkflowTriggerBinding.config}. */
    config: unknown;
    display?: TriggerKindDisplay;
  }>;
  parameters?: ParameterInfo[];
  arguments?: StepArgument[];
  condition?: string;
  loopVariable?: string;
  loopIterable?: string;
  duration?: string;
  stateExpression?: string;
  workflowName?: string;
  workflowInputExpression?: string;
  workflowTarget?: WorkflowCallTargetDescriptor;
  returnExpression?: string;
  functionName?: string;
  parentId?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: "sequential" | "branch-true" | "branch-false" | "parallel";
}

export interface WorkflowCapabilities {
  batchProcessing: boolean;
  cancellation: boolean;
}

export interface WorkflowExportTarget {
  modulePath: string;
  exportName: string;
}

export interface BoundaryRetryDescriptor {
  maxAttemptsExpression?: string;
  backoff?: {
    initialExpression?: string;
    maximumExpression?: string;
    multiplierExpression?: string;
  };
}

export interface BoundaryRateLimitDescriptor {
  globalKeyExpression: string;
  partitionKeyExpression?: string;
  capacityExpression: string;
  refillRatePerSecondExpression: string;
  costExpression?: string;
}

export interface BoundaryExecutionDescriptor {
  type: "boundary";
  topLevelIndex: number;
  nodeId: string;
  sourceRange: SourceRange;
  runRange: SourceRange;
  retry: BoundaryRetryDescriptor;
  rateLimits?: BoundaryRateLimitDescriptor[];
}

export interface PhysicalBatchStepPolicyDescriptor {
  maxItemsExpression: string;
  maxWaitMsExpression: string;
  maxBytesExpression?: string;
  rateLimitsExpression?: string;
  partitionByExpression?: string;
}

export interface PhysicalBatchStepDescriptor {
  nodeId: string;
  functionName: string;
  sourceRange: SourceRange;
  policy: PhysicalBatchStepPolicyDescriptor;
  exportTarget: WorkflowExportTarget;
}

export interface BatchFailurePolicyDescriptor {
  mode: "continue" | "fail_fast";
  maxFailures?: number;
}

export interface BatchExecutionDescriptor {
  type: "batch";
  topLevelIndex: number;
  nodeId: string;
  sourceRange: SourceRange;
  source: { sourceRange: SourceRange };
  process: {
    sourceRange: SourceRange;
    stepNodeIds: string[];
    physicalSteps: PhysicalBatchStepDescriptor[];
  };
  failurePolicy: BatchFailurePolicyDescriptor;
  sink?: { sourceRange: SourceRange };
}

export type WorkflowExecutionUnitDescriptor =
  | BoundaryExecutionDescriptor
  | BatchExecutionDescriptor;

export interface WorkflowExecutionDescriptor {
  exportTarget: WorkflowExportTarget;
  steps: WorkflowExecutionUnitDescriptor[];
}

export interface WorkflowCallTargetDescriptor {
  exportTarget: WorkflowExportTarget;
  capabilities: WorkflowCapabilities;
  execution: WorkflowExecutionDescriptor;
}

/** A JSON value that was written as a constant expression in source. */
export type JsonConstant =
  | null
  | boolean
  | number
  | string
  | JsonConstant[]
  | { [key: string]: JsonConstant };

/**
 * A workflow's declared subscription to a host trigger kind, extracted
 * statically from `defineWorkflow`'s `triggers` list. `config` always holds
 * a {@link JsonConstant} — the parser rejects computed expressions — so
 * hosts can introspect bindings without executing project code. Typed
 * `unknown` so the OpenAPI-derived response types stay assignable.
 */
export interface WorkflowTriggerBinding {
  kind: string;
  config: unknown;
  sourceRange: SourceRange;
}

export interface WorkflowGraph {
  name: string;
  capabilities: WorkflowCapabilities;
  execution: WorkflowExecutionDescriptor;
  displayName?: string;
  description?: string;
  controls?: { cancel?: true };
  input: { parameters: ParameterInfo[] };
  /**
   * JSON Schema of the workflow input (the first step's input type). `{}`
   * when the type could not be derived — permissive, never rejecting.
   */
  inputSchema: unknown;
  /** JSON Schema of the last step's resolved output. `{}` when unknown. */
  outputSchema: unknown;
  /** Host trigger kinds this workflow subscribes to. */
  triggers: WorkflowTriggerBinding[];
  connections: WorkflowConnectionRequirement[];
  /**
   * Whether any execution path can leave the run waiting on the clock or the
   * queue — a pause, a retry policy, a rate limit, a batch, or a child
   * workflow call. `false` is a hard guarantee that a sync trigger firing
   * returns a completed result.
   */
  canSuspend: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  sourceCode: string;
  filePath?: string;
  projectFiles?: string[];
}

export interface WorkflowConnectionRequirement {
  alias: string;
  principal?: "member" | "service" | "either";
  capabilities?: string[];
  optional?: boolean;
}

export interface DiscoveredWorkflow {
  functionName: string;
  capabilities: WorkflowCapabilities;
  filePath: string;
  graph: WorkflowGraph;
}

export interface ParseError {
  file?: string;
  message: string;
}

export interface ProjectParseResult {
  workflows: DiscoveredWorkflow[];
  secrets: DeclaredSecret[];
  /**
   * The app-facing contract surface, when `workflows/src/app-api.ts` exists.
   * Property names on the exported contract object become the callable set
   * apps are authorized against.
   */
  appApi: AppApiSurface | null;
  errors: ParseError[];
}

/** Conventional location of the app contract surface inside a project. */
export const APP_API_SOURCE_PATH = "workflows/src/app-api.ts";

export interface AppApiSurface {
  filePath: string;
  entries: AppApiEntry[];
}

export interface AppApiEntry {
  /** Name apps call — the property name on the contract object. */
  exposedName: string;
  /** The workflow function it resolves to. */
  workflowName: string;
  capabilities: WorkflowCapabilities;
  /** JSON Schema of the workflow's input, joined from its parsed graph. */
  inputSchema?: unknown;
  /** JSON Schema of the workflow's resolved output. */
  outputSchema?: unknown;
}

/** A secret declared in project code via `defineSecrets({ ... })`. */
export interface DeclaredSecret {
  name: string;
  label?: string;
  description?: string;
  required: boolean;
  default?: string;
  filePath: string;
}
