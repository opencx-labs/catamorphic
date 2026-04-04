import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export function ReturnNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode;

  return (
    <div className="catamorphic-node catamorphic-return-node">
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-node-icon">🏁</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">Return</div>
        {node.returnExpression && (
          <div className="catamorphic-node-subtitle">
            {node.returnExpression}
          </div>
        )}
      </div>
    </div>
  );
}
