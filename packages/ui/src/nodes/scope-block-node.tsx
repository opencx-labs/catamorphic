import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export function ScopeBlockNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { depth?: number };
  const nestLevel = Math.min(node.depth ?? 0, 3);
  const borderOpacity = 0.3 + nestLevel * 0.12;

  return (
    <div
      className="catamorphic-scope-block-node"
      style={{
        width: "100%",
        height: "100%",
        borderColor: `rgba(148, 163, 184, ${borderOpacity})`,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-scope-block-header">
        <span className="catamorphic-scope-block-icon">{ }</span>
        <span className="catamorphic-scope-block-label">{node.label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
