import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { friendlyParamName, friendlyType } from "../display-utils.js";

export function TriggerNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode;
  return (
    <div className="catamorphic-node catamorphic-trigger-node">
      <Handle type="source" position={Position.Bottom} />
      <div className="catamorphic-node-icon">⚡</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{node.label}</div>
        {node.description && (
          <div className="catamorphic-node-description">{node.description}</div>
        )}
        {node.parameters && node.parameters.length > 0 && (
          <div className="catamorphic-node-params">
            {node.parameters.map((p) => (
              <span key={p.name} className="catamorphic-param-badge">
                {p.displayName ?? friendlyParamName(p.name)}:{" "}
                {friendlyType(p.type)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
