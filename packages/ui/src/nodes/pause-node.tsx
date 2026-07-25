import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { CirclePause } from "lucide-react";

export function PauseNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { executionStatus?: string };
  const label =
    node.label && !node.label.toLowerCase().startsWith("pause")
      ? node.label
      : "Waiting for input";

  return (
    <div
      className="catamorphic-node catamorphic-pause-node"
      data-execution-status={node.executionStatus}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-node-icon">
        <CirclePause aria-hidden="true" size={18} strokeWidth={1.8} />
      </div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
