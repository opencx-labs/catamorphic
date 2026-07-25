export type WorkflowNodeType =
  | "trigger"
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

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  description?: string;
  sourceRange: SourceRange;
  metadata: Record<string, string>;
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
  persistedContinuations: boolean;
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

export interface BoundaryExecutionDescriptor {
  type: "boundary";
  topLevelIndex: number;
  nodeId: string;
  sourceRange: SourceRange;
  runRange: SourceRange;
  retry: BoundaryRetryDescriptor;
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

export interface WorkflowGraph {
  name: string;
  capabilities: WorkflowCapabilities;
  execution: WorkflowExecutionDescriptor;
  displayName?: string;
  description?: string;
  controls?: { cancel?: true };
  trigger: { parameters: ParameterInfo[] };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  sourceCode: string;
  filePath?: string;
  projectFiles?: string[];
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
  errors: ParseError[];
}
