import type { NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";
import { BatchNode } from "./batch-node.js";
import { BoundaryNode } from "./boundary-node.js";
import { BranchNode } from "./branch-node.js";
import { CallWorkflowNode } from "./call-workflow-node.js";
import { DelayNode } from "./delay-node.js";
import { IfBlockNode } from "./if-block-node.js";
import { InputNode } from "./input-node.js";
import { LoopBlockNode } from "./loop-block-node.js";
import { ParallelBlockNode } from "./parallel-block-node.js";
import { ParallelNode } from "./parallel-node.js";
import { PauseNode } from "./pause-node.js";
import { ReturnNode } from "./return-node.js";
import { ScopeBlockNode } from "./scope-block-node.js";
import { SinkNode } from "./sink-node.js";
import { SourceNode } from "./source-node.js";
import { StepNode } from "./step-node.js";

export const nodeTypes: Record<string, ComponentType<NodeProps>> = {
  input: InputNode,
  source: SourceNode,
  sink: SinkNode,
  step: StepNode,
  branch: BranchNode,
  "if-block": IfBlockNode,
  "loop-block": LoopBlockNode,
  parallel: ParallelNode,
  "parallel-block": ParallelBlockNode,
  "scope-block": ScopeBlockNode,
  "durable-boundary": BoundaryNode,
  batch: BatchNode,
  pause: PauseNode,
  "call-workflow": CallWorkflowNode,
  delay: DelayNode,
  return: ReturnNode,
};

export {
  BatchNode,
  BoundaryNode,
  BranchNode,
  CallWorkflowNode,
  DelayNode,
  IfBlockNode,
  InputNode,
  LoopBlockNode,
  ParallelBlockNode,
  ParallelNode,
  PauseNode,
  ReturnNode,
  ScopeBlockNode,
  SinkNode,
  SourceNode,
  StepNode,
};
