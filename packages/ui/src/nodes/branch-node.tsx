import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { prettyCondition } from "../display-utils.js";

export function BranchNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { depth?: number };
  const nestLevel = Math.min(node.depth ?? 0, 3);

  const borderOpacity = 0.3 + nestLevel * 0.12;
  const isElse = !node.condition;
  const branchType =
    (node.metadata?.branchType as string) ?? (isElse ? "else" : "if");

  return (
    <div
      className="catamorphic-branch-node"
      style={{
        width: "100%",
        height: "100%",
        borderColor: isElse
          ? `rgba(161, 161, 170, ${borderOpacity})`
          : `rgba(168, 85, 247, ${borderOpacity})`,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-branch-header">
        <span
          className={`catamorphic-branch-badge ${isElse ? "catamorphic-branch-badge-else" : ""}`}
        >
          {branchType}
        </span>
        <span className="catamorphic-branch-condition">
          {node.condition ? prettyCondition(node.condition) : ""}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
