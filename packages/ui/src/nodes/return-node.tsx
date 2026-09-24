import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Flag } from "lucide-react";

export function ReturnNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { executionStatus?: string };

  return (
    <div
      className="catamorphic-node catamorphic-return-node"
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
        <Flag aria-hidden="true" size={18} strokeWidth={1.8} />
      </div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{node.label}</div>
      </div>
      {node.label === "Item result" && (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}
