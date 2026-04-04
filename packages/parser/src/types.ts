export type WorkflowNodeType =
  | "trigger"
  | "step"
  | "branch"
  | "if-block"
  | "loop-block"
  | "parallel"
  | "parallel-block"
  | "scope-block"
  | "delay"
  | "return";

export interface SourceRange {
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
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
  returnExpression?: string;
  functionName?: string;
  parentId?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type:
    | "sequential"
    | "branch-true"
    | "branch-false"
    | "parallel";
}

export interface WorkflowGraph {
  name: string;
  displayName?: string;
  description?: string;
  trigger: { parameters: ParameterInfo[] };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  sourceCode: string;
}
