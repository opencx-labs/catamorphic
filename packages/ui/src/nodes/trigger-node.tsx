import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export function TriggerNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode;
  return (
    <div className="catamorphic-node catamorphic-trigger-node">
      <Handle type="source" position={Position.Bottom} />
      <div className="catamorphic-node-icon">⚡</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{node.label}</div>
      </div>
    </div>
  );
}
