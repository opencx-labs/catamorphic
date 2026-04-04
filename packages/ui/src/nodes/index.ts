import type { NodeProps } from "@xyflow/react";
import type { ComponentType } from "react";
import { BranchNode } from "./branch-node.js";
import { DelayNode } from "./delay-node.js";
import { IfBlockNode } from "./if-block-node.js";
import { LoopBlockNode } from "./loop-block-node.js";
import { ParallelBlockNode } from "./parallel-block-node.js";
import { ParallelNode } from "./parallel-node.js";
import { ReturnNode } from "./return-node.js";
import { ScopeBlockNode } from "./scope-block-node.js";
import { StepNode } from "./step-node.js";
import { TriggerNode } from "./trigger-node.js";

export const nodeTypes: Record<string, ComponentType<NodeProps>> = {
  trigger: TriggerNode,
  step: StepNode,
  branch: BranchNode,
  "if-block": IfBlockNode,
  "loop-block": LoopBlockNode,
  parallel: ParallelNode,
  "parallel-block": ParallelBlockNode,
  "scope-block": ScopeBlockNode,
  delay: DelayNode,
  return: ReturnNode,
};

export {
  BranchNode,
  DelayNode,
  IfBlockNode,
  LoopBlockNode,
  ParallelBlockNode,
  ParallelNode,
  ReturnNode,
  ScopeBlockNode,
  StepNode,
  TriggerNode,
};
