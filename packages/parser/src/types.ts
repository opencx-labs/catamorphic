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
  | "delay"
  | "return";

export type WorkflowKind = "regular" | "batch";

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

export interface WorkflowGraph {
  name: string;
  /**
   * Parsers always set this field. It remains optional so existing consumers
   * that construct regular workflow graphs stay source-compatible.
   */
  kind?: WorkflowKind;
  displayName?: string;
  description?: string;
  trigger: { parameters: ParameterInfo[] };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  sourceCode: string;
  filePath?: string;
  projectFiles?: string[];
}

export interface DiscoveredWorkflow {
  functionName: string;
  /**
   * Parsers always set this field. It remains optional for source compatibility
   * with regular workflow discovery results constructed by consumers.
   */
  kind?: WorkflowKind;
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
