import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Split } from "lucide-react";

export function ParallelNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { executionStatus?: string };

  return (
    <div
      className="catamorphic-node catamorphic-parallel-node"
      data-execution-status={node.executionStatus}
    >
      <Handle type="target" position={Position.Top} />
      {node.executionStatus && (
        <span
          className="catamorphic-node-exec-indicator"
          data-status={node.executionStatus}
        />
      )}
      <div className="catamorphic-node-icon">
        <Split aria-hidden="true" size={18} strokeWidth={1.8} />
      </div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{node.label}</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
