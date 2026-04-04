import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export function DelayNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode;

  return (
    <div className="catamorphic-node catamorphic-delay-node">
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-node-icon">⏱️</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">
          {node.duration ?? node.label}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
