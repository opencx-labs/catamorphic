import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ContainerToggle } from "./container-toggle.js";
import { NodeIcon } from "./node-icon.js";

export function BoundaryNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & {
    depth?: number;
    collapsed?: boolean;
    hasChildren?: boolean;
  };
  const nestLevel = Math.min(node.depth ?? 0, 3);
  const borderOpacity = 0.32 + nestLevel * 0.12;
  const collapsed = node.collapsed ?? false;
  const label = node.label || "Retry scope";

  return (
    <div
      className={`catamorphic-boundary-node${collapsed ? " catamorphic-container-collapsed" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        borderColor: `rgba(148, 163, 184, ${borderOpacity})`,
      }}
      data-testid="boundary"
      data-collapsed={collapsed}
    >
      <Handle type="target" position={Position.Top} />
      {(node.label || collapsed) && (
        <div className="catamorphic-boundary-header">
          <span className="catamorphic-boundary-icon">
            <NodeIcon name={node.metadata.icon ?? "layers"} />
          </span>
          <span className="catamorphic-boundary-label">{label}</span>
        </div>
      )}
      {node.hasChildren && (
        <ContainerToggle nodeId={node.id} collapsed={collapsed} label={label} />
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
