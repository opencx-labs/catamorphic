import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export function LoopBlockNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { depth?: number };
  const nestLevel = Math.min(node.depth ?? 0, 3);

  const borderOpacity = 0.3 + nestLevel * 0.12;

  return (
    <div
      className="catamorphic-loop-block-node"
      style={{
        width: "100%",
        height: "100%",
        borderColor: `rgba(249, 115, 22, ${borderOpacity})`,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-loop-block-header">
        <span className="catamorphic-loop-block-icon">🔄</span>
        <span className="catamorphic-loop-block-label">{node.label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
